//! Command implementations, one function per channel plus the thin Tauri
//! wrapper. Pattern (every namespace follows it):
//!
//! ```ignore
//! // Pure logic: directly unit-tested with a scratch AppState.
//! pub(crate) fn cmd(state: &AppState, args: &[Value], log: &mut LogSink)
//!     -> Result<Value, CommandError>
//!
//! // Dumb wrapper: envelope + stderr mirror. Too small to misbehave;
//! // B2's contract suite drives the wrapper through the real invoke loop.
//! #[tauri::command(rename = "namespace:channel")]
//! fn channel_name(state: State<AppState>, args: Vec<Value>) -> Value { … }
//! ```
//!
//! The `rename` is LOAD-BEARING: the bridge invokes the Electron channel
//! string (`invoke('library:getAll', …)`), and without it Tauri registers
//! the Rust snake_case fn name — every call misses. The `handle()` channel
//! label and the rename must be identical.
//!
//! Arg encoding: the bridge sends `{args:[...]}` positionally (bridge.ts) —
//! each command indexes its params and treats JSON null as absent, matching
//! the preload's `?? default` idioms.

pub mod api;
pub mod app;
pub mod auth;
pub mod download;
pub mod kavita;
pub mod library;
pub mod library_jobs;
pub mod library_mutate;
pub mod log;
pub mod search;
pub mod settings;
pub mod shell;
pub mod updater;

use serde_json::Value;

use crate::envelope::LogRecord;
use crate::state::AppState;

/// Forward envelope log lines into the app logger under the command's scope
/// (replaces the B2a stderr mirror — the file+ring logger has landed).
pub(crate) fn forward(state: &AppState, channel: &str, logs: Vec<LogRecord>) {
    let logger = state.logger.scope(channel);
    for record in logs {
        // Envelope records carry `message`; the logger's structural key is
        // `msg` — mapped here, everything else passes through (write_record
        // re-validates, re-redacts and preserves errorIds).
        let mut value = serde_json::Map::new();
        value.insert("level".to_string(), Value::String(record.level.to_string()));
        value.insert("scope".to_string(), Value::String(record.scope));
        value.insert("msg".to_string(), Value::String(record.message));
        for (k, v) in record.fields.as_object().cloned().unwrap_or_default() {
            value.insert(k, v);
        }
        logger.write_record(&Value::Object(value));
    }
}

/// Phase B exit criterion (4): the errorId a user quotes from a thrown
/// command must be greppable in the shipped log file *and* the in-memory
/// ring, repeat throws must mint distinct ids, a ≥250 ms handler must warn,
/// and soft-fails must stay id-free. The envelope unit tests prove `handle()`
/// mints the right shapes; these prove the lines survive `forward()` into
/// the real file+ring pipeline (scratch dir only — never the live log).
#[cfg(test)]
mod log_parity_tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use crate::envelope::{handle, CommandError, SLOW_HANDLER_MS};
    use crate::log::records_to_json;
    use crate::state::AppState;

    use super::forward;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "kopibon-log-parity-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        (state, dir)
    }

    fn file_text(state: &AppState) -> String {
        std::fs::read_to_string(state.logger.log_dir().join("app.log"))
            .expect("app.log written synchronously")
    }

    fn ring_text(state: &AppState) -> String {
        records_to_json(&state.logger.ring_buffer()).to_string()
    }

    #[test]
    fn thrown_error_id_reaches_file_and_ring() {
        let (state, dir) = scratch_state();
        let outcome = handle("parity:boom", |_| {
            Err(CommandError::Thrown("kaput".to_string()))
        });
        let id = outcome.value["errorId"]
            .as_str()
            .expect("errorId minted")
            .to_string();
        forward(&state, "parity:boom", outcome.logs);
        assert!(file_text(&state).contains(&id), "file carries {id}");
        assert!(ring_text(&state).contains(&id), "ring carries {id}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repeat_throws_mint_different_file_ids() {
        let (state, dir) = scratch_state();
        let mut ids = Vec::new();
        for _ in 0..2 {
            let outcome = handle("parity:boom", |_| {
                Err(CommandError::Thrown("x".to_string()))
            });
            ids.push(outcome.value["errorId"].as_str().expect("id").to_string());
            forward(&state, "parity:boom", outcome.logs);
        }
        assert_ne!(ids[0], ids[1], "fresh id per throw (09 §Phase B exit 4)");
        let text = file_text(&state);
        assert!(text.contains(&ids[0]) && text.contains(&ids[1]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn slow_handler_warning_reaches_file_and_ring() {
        let (state, dir) = scratch_state();
        let outcome = handle("parity:slow", |_| {
            std::thread::sleep(std::time::Duration::from_millis(
                SLOW_HANDLER_MS as u64 + 100,
            ));
            Ok(json!({ "success": true }))
        });
        assert!(!outcome.logs.is_empty(), "slow success warns");
        forward(&state, "parity:slow", outcome.logs);
        for text in [file_text(&state), ring_text(&state)] {
            assert!(
                text.contains("Slow IPC handler"),
                "slow warning, got {text}"
            );
            assert!(text.contains("parity:slow"), "channel tagged, got {text}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn soft_fail_writes_no_error_id() {
        let (state, dir) = scratch_state();
        let outcome = handle("parity:soft", |_| {
            Err(CommandError::SoftFail("nope".to_string()))
        });
        assert!(outcome.logs.is_empty());
        forward(&state, "parity:soft", outcome.logs);
        let text = ring_text(&state);
        assert!(
            !text.contains("errorId"),
            "soft fail stays id-free, got {text}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
