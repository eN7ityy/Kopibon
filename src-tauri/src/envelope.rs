//! The `handle()` port (`src/main/ipc/handle.ts:51-82` + `logger.ts` errorId).
//!
//! Every Tauri command runs its body through [`handle`]: success values pass
//! through untouched (each command builds its own `{success:true, data}` —
//! see 02-ipc-surface §1.1), while failures split two ways —
//! [`CommandError::Thrown`] becomes `{success:false, error, errorId}` with a
//! fresh `errorId` logged alongside the failure (the user quotes it, the log
//! line is found), and [`CommandError::SoftFail`] becomes
//! `{success:false, error}` with no `errorId` (e.g. `kavita:testConnection`,
//! `library:getSeriesFacts`).
//! A body that runs ≥250 ms logs a slow-handler warning even on success
//! (`SLOW_HANDLER_MS`, `handle.ts:49`), and every execution is tracked in
//! the in-flight registry for freeze attribution (`inFlightHandlers()`).
//!
//! Log lines go to an injected [`LogSink`] (`FnMut` — the same convention as
//! kopibon-core's pump `log` callbacks), so tests inspect them without
//! globals; the command wrapper forwards to the real logger.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// A structured log line produced while handling a command.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub level: &'static str,
    pub scope: String,
    pub message: String,
    pub fields: Value,
}

/// Injected log sink (see module docs).
pub type LogSink<'a> = dyn FnMut(LogRecord) + 'a;

/// How long a handler may run before it is worth a log line (handle.ts:49).
/// Under Tauri a slow command does not freeze the window the way it did
/// under Electron main, but the log analysis still depends on the shape.
pub const SLOW_HANDLER_MS: u128 = 250;

/// The two failure shapes of 02-ipc-surface §1.1.
///
/// B2-namespace commits construct the variants as their commands land; until
/// then the enum is allow-listed (workspace deny-warnings discipline applies
/// to this crate — see Cargo.toml `[lints]`).
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub enum CommandError {
    /// Thrown: envelope `{success:false, error, errorId}` + error log line.
    Thrown(String),
    /// Returned failure: `{success:false, error}`, no errorId, no error log.
    SoftFail(String),
}

/// The outcome of [`handle`]: the exact value returned to the renderer, plus
/// the log lines for the command wrapper to forward.
pub struct Outcome {
    pub value: Value,
    pub logs: Vec<LogRecord>,
}

/// Run a command body under the envelope (handle.ts:61-81).
pub fn handle(
    channel: &str,
    f: impl FnOnce(&mut LogSink) -> Result<Value, CommandError>,
) -> Outcome {
    let registry = in_flight_registry();

    let started = Instant::now();
    registry
        .lock()
        .map(|mut r| r.insert(channel.to_string(), started))
        .ok();
    struct Guard<'a> {
        channel: &'a str,
        registry: &'a Mutex<HashMap<String, Instant>>,
    }
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.registry
                .lock()
                .map(|mut r| r.remove(self.channel))
                .ok();
        }
    }
    let _guard = Guard { channel, registry };

    let mut logs = Vec::new();
    let mut sink = |record: LogRecord| logs.push(record);
    let result = f(&mut sink);
    let elapsed_ms = started.elapsed().as_millis();

    match result {
        Ok(value) => {
            if elapsed_ms >= SLOW_HANDLER_MS {
                logs.push(LogRecord {
                    level: "warn",
                    scope: channel.to_string(),
                    message: format!("Slow IPC handler: {elapsed_ms}ms"),
                    fields: json!({ "channel": channel, "ms": elapsed_ms }),
                });
            }
            Outcome { value, logs }
        }
        Err(CommandError::SoftFail(error)) => Outcome {
            value: json!({ "success": false, "error": error }),
            logs,
        },
        Err(CommandError::Thrown(message)) => {
            let error_id = new_error_id();
            logs.push(LogRecord {
                level: "error",
                scope: channel.to_string(),
                message: format!("IPC handler failed: {message}"),
                fields: json!({ "error": message, "errorId": error_id }),
            });
            Outcome {
                value: json!({ "success": false, "error": message, "errorId": error_id }),
                logs,
            }
        }
    }
}

/// Channels currently executing, longest first (`inFlightHandlers()`,
/// handle.ts:34-39). Used by the freeze-attribution story (02 §1.2): a hang
/// with in-flight commands points at the core, without at the renderer.
/// First consumer is B3's window-event hookup; allow-listed until then.
#[allow(dead_code)]
pub fn in_flight_handlers() -> Vec<InFlight> {
    let now = Instant::now();
    let mut out: Vec<InFlight> = in_flight_registry()
        .lock()
        .map(|r| {
            r.iter()
                .map(|(channel, started)| InFlight {
                    channel: channel.clone(),
                    ms: now.duration_since(*started).as_millis(),
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|h| std::cmp::Reverse(h.ms));
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct InFlight {
    pub channel: String,
    pub ms: u128,
}

/// The single process-global in-flight registry (handle.ts:31) — one owner,
/// shared by `handle` (insert/remove) and `in_flight_handlers` (snapshot).
fn in_flight_registry() -> &'static Mutex<HashMap<String, Instant>> {
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forward outcome log lines to stderr as JSON (command wrapper helper).
/// TEMPORARY until B2-log lands the file+ring logger: today the lines are
/// visible in dev runs; the shape (`level/scope/message/fields`) already
/// matches the `LogRecord` the logger will persist.
pub fn forward_to_stderr(logs: &[LogRecord]) {
    for record in logs {
        eprintln!(
            "{}",
            json!({
                "level": record.level,
                "scope": record.scope,
                "message": record.message,
                "fields": record.fields,
            })
        );
    }
}

/// Generate a unique error identifier (`newErrorId()`, logger.ts:100-122).
/// Format: `E-` + 8 Crockford base32 chars from 8 crypto-random bytes.
pub fn new_error_id() -> String {
    const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).expect("errorId randomness");
    let mut bits: u64 = 0;
    let mut bits_remaining: u32 = 0;
    let mut chars: Vec<u8> = Vec::with_capacity(8);
    for byte in buf {
        bits = (bits << 8) | byte as u64;
        bits_remaining += 8;
        while bits_remaining >= 5 && chars.len() < 8 {
            bits_remaining -= 5;
            chars.push(CROCKFORD[((bits >> bits_remaining) & 0x1f) as usize]);
        }
    }
    while chars.len() < 8 {
        chars.push(CROCKFORD[(bits & 0x1f) as usize]);
        bits >>= 5;
    }
    format!("E-{}", String::from_utf8(chars).expect("crockford ascii"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CROCKFORD: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    #[test]
    fn error_id_shape() {
        let id = new_error_id();
        assert!(id.starts_with("E-"), "prefix, got {id}");
        let tail = &id[2..];
        assert_eq!(tail.len(), 8, "8 chars, got {id}");
        assert!(
            tail.chars().all(|c| CROCKFORD.contains(c)),
            "crockford only, got {id}"
        );
    }

    #[test]
    fn error_id_unique() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_error_id()).collect();
        assert_eq!(ids.len(), 1000, "fresh id per error (09 §Phase B exit 4)");
    }

    #[test]
    fn handle_success_passthrough_untouched() {
        let outcome = handle("chan:ok", |_log| {
            Ok(json!({ "success": true, "data": [1, 2] }))
        });
        assert_eq!(outcome.value, json!({ "success": true, "data": [1, 2] }));
        assert!(outcome.logs.is_empty(), "fast success logs nothing");
    }

    #[test]
    fn handle_thrown_envelope_with_error_id() {
        let outcome = handle("chan:boom", |_log| {
            Err(CommandError::Thrown("kaput".to_string()))
        });
        let error_id = outcome.value["errorId"].as_str().expect("errorId minted");
        assert_eq!(outcome.value["success"], json!(false));
        assert_eq!(outcome.value["error"], json!("kaput"));
        assert!(error_id.starts_with("E-"));
        assert_eq!(outcome.logs.len(), 1);
        assert_eq!(outcome.logs[0].level, "error");
        assert_eq!(outcome.logs[0].fields["errorId"], json!(error_id));
    }

    #[test]
    fn handle_repeat_throws_mint_different_ids() {
        let a = handle("chan:boom", |_log| {
            Err(CommandError::Thrown("x".to_string()))
        });
        let b = handle("chan:boom", |_log| {
            Err(CommandError::Thrown("x".to_string()))
        });
        assert_ne!(a.value["errorId"], b.value["errorId"]);
    }

    #[test]
    fn handle_soft_fail_without_error_id() {
        let outcome = handle("chan:soft", |_log| {
            Err(CommandError::SoftFail("nope".to_string()))
        });
        assert_eq!(outcome.value, json!({ "success": false, "error": "nope" }));
        assert!(
            outcome.value.get("errorId").is_none(),
            "soft fail mints nothing"
        );
        assert!(outcome.logs.is_empty(), "soft fail logs no error line");
    }

    #[test]
    fn handle_slow_success_warns() {
        let outcome = handle("chan:slow", |_log| {
            std::thread::sleep(std::time::Duration::from_millis(
                SLOW_HANDLER_MS as u64 + 50,
            ));
            Ok(json!({ "success": true }))
        });
        assert_eq!(outcome.value, json!({ "success": true }));
        assert_eq!(outcome.logs.len(), 1);
        assert_eq!(outcome.logs[0].level, "warn");
        assert!(outcome.logs[0].message.starts_with("Slow IPC handler:"));
        assert_eq!(outcome.logs[0].fields["channel"], json!("chan:slow"));
    }

    #[test]
    fn handle_tracks_in_flight_during_body() {
        let outcome = handle("chan:tracked", |_log| {
            let in_flight = in_flight_handlers();
            assert!(in_flight.iter().any(|h| h.channel == "chan:tracked"));
            Ok(json!({ "success": true }))
        });
        assert_eq!(outcome.value, json!({ "success": true }));
        assert!(
            !in_flight_handlers()
                .iter()
                .any(|h| h.channel == "chan:tracked"),
            "registry cleared in finally"
        );
    }

    #[test]
    fn in_flight_sorted_longest_first() {
        let _a = handle("chan:outer", |_log| {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let _b = handle("chan:inner", |_log| {
                let in_flight = in_flight_handlers();
                let pos = |c: &str| in_flight.iter().position(|h| h.channel == c).unwrap();
                assert!(
                    pos("chan:outer") < pos("chan:inner"),
                    "longest first: {in_flight:?}"
                );
                Ok(json!({ "success": true }))
            });
            Ok(json!({ "success": true }))
        });
    }
}
