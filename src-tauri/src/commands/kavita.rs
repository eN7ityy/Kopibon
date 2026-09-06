//! `kavita:*` commands (02-ipc-surface §2.12, `kavita.ipc.ts:11-69`).
//!
//! Settings-pane helpers only — scan/delete are deliberately unexposed and
//! fire server-side from the file-operation handlers (later batch). All
//! four channels take optional `(url, apiKey)` overrides so the pane tests
//! unsaved form values; without them the persisted settings apply.
//! Failure shapes: `testConnection` fails SOFT (in-band `{success:false,
//! error}`, no errorId); `getLibraries` THROWS (envelope + errorId —
//! `kavita.ipc.ts:29-30`); `getItemCount`/`getSeriesDetail` never fail
//! (null hides the figure / renders nothing).

use kopibon_core::kavita::{library_type_name, KavitaClient};
use kopibon_core::metadata::mappers::{Clock, SystemClock};
use serde_json::{json, Value};
use tauri::State;

use crate::envelope::{handle, CommandError, LogSink};
use crate::kavita::{effective_config, is_enabled};
use crate::state::AppState;

use super::forward;

/// Positional optional string: JSON null (or absent/wrong-type) is absent —
/// the bridge's `?? default` idiom — while `""` is a REAL override that
/// wins over settings (`readConfig` uses `??`, not `||`).
fn opt_str(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(|v| v.as_str())
}

/// Omit empty optionals (`user?.kavitaVersion || undefined`): the key is
/// absent rather than `""`/`null`.
fn insert_non_empty(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value {
        if !v.is_empty() {
            map.insert(key.to_string(), Value::String(v));
        }
    }
}

/// `kavita:testConnection` (`kavita.ipc.ts:17-26`).
pub(crate) fn test_connection_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let config = effective_config(&state.db, opt_str(args, 0), opt_str(args, 1));
    let kavita = state
        .kavita
        .lock()
        .map_err(|_| CommandError::Thrown("kavita lock poisoned".to_string()))?;
    let result = KavitaClient::new(kavita.transport(), config).test_connection(None, None);
    if result.ok {
        let mut data = serde_json::Map::new();
        insert_non_empty(&mut data, "serverVersion", result.version);
        insert_non_empty(&mut data, "username", result.username);
        Ok(Value::Object(
            [
                (String::from("success"), Value::Bool(true)),
                (String::from("data"), Value::Object(data)),
            ]
            .into_iter()
            .collect(),
        ))
    } else {
        Err(CommandError::SoftFail(
            "Could not connect to Kavita".to_string(),
        ))
    }
}

/// `kavita:getLibraries` (`kavita.ipc.ts:28-33`): throws → envelope.
pub(crate) fn get_libraries_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let config = effective_config(&state.db, opt_str(args, 0), opt_str(args, 1));
    let kavita = state
        .kavita
        .lock()
        .map_err(|_| CommandError::Thrown("kavita lock poisoned".to_string()))?;
    let libraries = KavitaClient::new(kavita.transport(), config)
        .get_libraries()
        .map_err(CommandError::Thrown)?;
    let mapped: Vec<Value> = libraries
        .iter()
        .map(|lib| {
            let mut out = serde_json::Map::new();
            out.insert(
                "id".to_string(),
                lib.get("id").cloned().unwrap_or(Value::Null),
            );
            out.insert(
                "name".to_string(),
                match lib.get("name").and_then(Value::as_str) {
                    Some(name) if !name.is_empty() => Value::String(name.to_string()),
                    _ => Value::String(String::new()),
                },
            );
            out.insert(
                "type".to_string(),
                match lib.get("type").and_then(Value::as_i64) {
                    Some(code) => Value::String(library_type_name(code).to_string()),
                    None => Value::String(String::new()),
                },
            );
            out.insert(
                "folders".to_string(),
                match lib.get("folders") {
                    Some(Value::Array(folders)) => Value::Array(folders.clone()),
                    _ => Value::Array(Vec::new()),
                },
            );
            Value::Object(out)
        })
        .collect();
    Ok(json!({ "success": true, "data": mapped }))
}

/// `kavita:getItemCount` (`kavita.ipc.ts:35-40`): never throws — null hides
/// the status-bar figure. Disabled, unconfigured, stale-cache and
/// failed-refetch-serves-stale all mirror `getItemCount` (`:306-338`).
pub(crate) fn get_item_count_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    // Same enabled check as isConfigured() (`:307-309`) — the checkbox
    // gates even override-driven reads.
    if !is_enabled(&state.db) {
        return Ok(json!({ "success": true, "data": null }));
    }
    let config = effective_config(&state.db, opt_str(args, 0), opt_str(args, 1));
    if config.url.is_empty() || config.api_key.is_empty() || config.library_id.is_empty() {
        return Ok(json!({ "success": true, "data": null }));
    }
    let clock = SystemClock;
    let now = clock.now_ms();
    let kavita = state
        .kavita
        .lock()
        .map_err(|_| CommandError::Thrown("kavita lock poisoned".to_string()))?;
    if let Some(cached) = kavita.fresh_item_count(now) {
        return Ok(json!({ "success": true, "data": cached }));
    }
    let stale = kavita.stale_item_count();
    let mut client = KavitaClient::new(kavita.transport(), config);
    match client.get_item_count(now) {
        Some(count) => {
            kavita.store_item_count(count, now);
            Ok(json!({ "success": true, "data": count }))
        }
        // Failed refetch serves the stale value (`:336`) — which on a cold
        // cache is None → null.
        None => Ok(json!({ "success": true, "data": stale })),
    }
}

/// `kavita:getSeriesDetail` (`kavita.ipc.ts:49-68`):
/// `(seriesName, title, url?, apiKey?, filePath?)` → detail|null.
pub(crate) fn get_series_detail_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_name = opt_str(args, 0).unwrap_or("");
    let title = opt_str(args, 1).unwrap_or("");
    let config = effective_config(&state.db, opt_str(args, 2), opt_str(args, 3));
    let file_path = opt_str(args, 4).filter(|s| !s.is_empty());
    let kavita = state
        .kavita
        .lock()
        .map_err(|_| CommandError::Thrown("kavita lock poisoned".to_string()))?;
    let detail = KavitaClient::new(kavita.transport(), config).find_series_detail(
        series_name,
        title,
        file_path,
    );
    Ok(json!({ "success": true, "data": detail.map(|d| d.to_value()) }))
}

#[tauri::command(rename = "kavita:testConnection")]
pub(crate) fn kavita_test_connection(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("kavita:testConnection", |log| {
        test_connection_impl(&state, &args, log)
    });
    forward(&state, "kavita:testConnection", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "kavita:getLibraries")]
pub(crate) fn kavita_get_libraries(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("kavita:getLibraries", |log| {
        get_libraries_impl(&state, &args, log)
    });
    forward(&state, "kavita:getLibraries", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "kavita:getItemCount")]
pub(crate) fn kavita_get_item_count(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("kavita:getItemCount", |log| {
        get_item_count_impl(&state, &args, log)
    });
    forward(&state, "kavita:getItemCount", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "kavita:getSeriesDetail")]
pub(crate) fn kavita_get_series_detail(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("kavita:getSeriesDetail", |log| {
        get_series_detail_impl(&state, &args, log)
    });
    forward(&state, "kavita:getSeriesDetail", outcome.logs);
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;

    mod tempfile_guard {
        pub struct Guard {
            dir: std::path::PathBuf,
        }
        impl Guard {
            pub fn new() -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "kopibon-kavita-cmd-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&dir).expect("scratch dir");
                Guard { dir }
            }
            pub fn path(&self) -> &std::path::Path {
                &self.dir
            }
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
    }

    fn test_state() -> (AppState, tempfile_guard::Guard) {
        let guard = tempfile_guard::Guard::new();
        let state = AppState::open(guard.path().to_path_buf()).expect("scratch state");
        (state, guard)
    }

    fn enable(state: &AppState) {
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::settings::set(conn, "kavitaEnabled", "true")?;
                kopibon_core::db::settings::set(conn, "kavitaUrl", "http://127.0.0.1:9")?;
                kopibon_core::db::settings::set(conn, "kavitaApiKey", "k")?;
                kopibon_core::db::settings::set(conn, "kavitaLibraryId", "6")
            })
            .expect("seed");
    }

    /// Disabled integration → null without touching the network.
    #[test]
    fn item_count_disabled_is_null() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = get_item_count_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": null }));
    }

    /// Unconfigured (no URL) → null without touching the network.
    #[test]
    fn item_count_unconfigured_is_null() {
        let (state, _guard) = test_state();
        state
            .db
            .with_writer(|conn| kopibon_core::db::settings::set(conn, "kavitaEnabled", "true"))
            .expect("seed");
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = get_item_count_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": null }));
    }

    /// Fresh cache serves without network; a failed refetch past the TTL
    /// serves the STALE value (`:332-337`); cold failure is null.
    #[test]
    fn item_count_cache_and_stale_fallback() {
        let (state, _guard) = test_state();
        enable(&state);
        let mut sink = |_: crate::envelope::LogRecord| {};
        // Cold: refused connection (port 9, instant) → null.
        let out = get_item_count_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": null }));
        // Seed the cache directly, then read inside the TTL → no network.
        {
            let kavita = state.kavita.lock().expect("lock");
            kavita.store_item_count(77, 1_000);
        }
        // Fresh read needs "now" < stored+60s — wall clock is way past, so
        // force freshness by re-storing at the current wall time.
        let now = SystemClock.now_ms();
        {
            let kavita = state.kavita.lock().expect("lock");
            kavita.store_item_count(77, now);
        }
        let out = get_item_count_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": 77 }));
        // Age it out → refetch fails (refused) → stale 77 served.
        {
            let kavita = state.kavita.lock().expect("lock");
            kavita.store_item_count(77, now - 61_000);
        }
        let out = get_item_count_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": 77 }));
    }

    /// `testConnection` against a refused port fails SOFT (no errorId):
    /// `{success:false, error}`.
    #[test]
    fn test_connection_refused_is_soft_fail() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let err = test_connection_impl(
            &state,
            &[json!("http://127.0.0.1:9"), json!("k")],
            &mut sink,
        )
        .expect_err("refused");
        assert_eq!(
            err,
            CommandError::SoftFail("Could not connect to Kavita".to_string())
        );
    }

    /// `getLibraries` against a refused port THROWS (envelope + errorId).
    #[test]
    fn get_libraries_refused_throws() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let err = get_libraries_impl(
            &state,
            &[json!("http://127.0.0.1:9"), json!("k")],
            &mut sink,
        )
        .expect_err("refused");
        assert!(
            matches!(err, CommandError::Thrown(_)),
            "thrown, not soft: {err:?}"
        );
    }

    /// `getSeriesDetail` with no match and no server → null, never throws.
    #[test]
    fn series_detail_unreachable_is_null() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = get_series_detail_impl(
            &state,
            &[
                json!("Nope"),
                json!("Nope"),
                json!("http://127.0.0.1:9"),
                json!("k"),
            ],
            &mut sink,
        )
        .expect("never throws");
        assert_eq!(out, json!({ "success": true, "data": null }));
    }
}
