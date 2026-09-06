//! `log:*` commands (02-ipc-surface §2.9, `src/main/index.ts:245-297`).
//!
//! Four channels bypass `handle()` with raw `ipcMain.handle` and hand-rolled
//! envelopes (`log:write`, `log:setLevel`, `log:getLevel`, `log:openFolder`);
//! the port keeps those exact shapes — including `log:write` returning
//! nothing and silently dropping invalid levels, and `log:setLevel`
//! returning `{success:false, error:'Invalid level'}` with NO errorId.
//! `log:openFolder` + `log:exportDiagnostics` need the opener plugin and the
//! settings/library repos — they land in B3 (noted below, not stubbed).

use serde_json::{json, Value};
use tauri::State;

use crate::envelope::{handle, CommandError, LogSink};
use crate::log::{records_to_json, LogLevel};
use crate::state::AppState;

use super::forward;

/// `log:write` (RAW — `index.ts:245`). `(level, scope, msg, fields?)` →
/// nothing. Invalid levels are dropped silently. Routes through a SCOPED
/// logger so `scope` is the record's scope field, not a user field.
pub(crate) fn write_impl(state: &AppState, args: &[Value]) {
    let level = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let Some(level) = LogLevel::parse(level) else {
        return;
    };
    let scope = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
    let msg = args.get(2).and_then(|v| v.as_str()).unwrap_or("");
    let fields = args.get(3).and_then(|v| v.as_object()).cloned();
    let logger = state.logger.scope(scope);
    match level {
        LogLevel::Error => logger.error(msg, fields),
        LogLevel::Warn => logger.warn(msg, fields),
        LogLevel::Info => logger.info(msg, fields),
        LogLevel::Debug => logger.debug(msg, fields),
    }
}

/// `log:getRecords` → ring-buffer records (`index.ts:265`).
pub(crate) fn get_records_impl(state: &AppState) -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": records_to_json(&state.logger.ring_buffer()) }))
}

/// `log:setLevel` (RAW — `index.ts:269`). Bad level → hand-rolled
/// `{success:false, error}` with no errorId; good level → `{success:true}`
/// (bare — no `data` key, exactly like 1.x).
pub(crate) fn set_level_impl(state: &AppState, args: &[Value]) -> Value {
    let level = args.first().and_then(|v| v.as_str()).unwrap_or("");
    match LogLevel::parse(level) {
        Some(level) => {
            state.logger.set_level(level);
            json!({ "success": true })
        }
        None => json!({ "success": false, "error": "Invalid level" }),
    }
}

/// `log:getLevel` (RAW — `index.ts:276`) → `{success:true, data}`.
pub(crate) fn get_level_impl(state: &AppState) -> Value {
    json!({ "success": true, "data": state.logger.level().as_str() })
}

/// `log:setRetention` (`index.ts:280`) — clamped 1–365, floored.
pub(crate) fn set_retention_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let days = args.first().and_then(|v| v.as_i64()).unwrap_or(14);
    let clamped = days.clamp(1, 365);
    state.logger.set_retention_days(clamped);
    Ok(json!({ "success": true }))
}

/// `log:getRetention` (`index.ts:289`).
pub(crate) fn get_retention_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": state.logger.retention_days() }))
}

#[tauri::command]
pub(crate) fn log_write(state: State<AppState>, args: Vec<Value>) {
    write_impl(&state, &args);
}

#[tauri::command]
pub(crate) fn log_get_records(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("log:getRecords", |_log| {
        let _ = &args;
        get_records_impl(&state)
    });
    forward(&state, "log:getRecords", outcome.logs);
    outcome.value
}

#[tauri::command]
pub(crate) fn log_set_level(state: State<AppState>, args: Vec<Value>) -> Value {
    set_level_impl(&state, &args)
}

#[tauri::command]
pub(crate) fn log_get_level(state: State<AppState>, _args: Vec<Value>) -> Value {
    get_level_impl(&state)
}

#[tauri::command]
pub(crate) fn log_set_retention(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("log:setRetention", |log| {
        set_retention_impl(&state, &args, log)
    });
    forward(&state, "log:setRetention", outcome.logs);
    outcome.value
}

#[tauri::command]
pub(crate) fn log_get_retention(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("log:getRetention", |log| {
        get_retention_impl(&state, &args, log)
    });
    forward(&state, "log:getRetention", outcome.logs);
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> (AppState, tempfile_guard::Guard) {
        let guard = tempfile_guard::Guard::new();
        let state = AppState::open(guard.path().to_path_buf()).expect("scratch state");
        (state, guard)
    }

    #[test]
    fn write_routes_scoped_and_drops_bad_levels() {
        let (state, _guard) = test_state();
        write_impl(
            &state,
            &[
                json!("info"),
                json!("renderer:view"),
                json!("hello"),
                json!({"n": 1}),
            ],
        );
        write_impl(&state, &[json!("bogus"), json!("x"), json!("dropped")]);
        let ring = state.logger.ring_buffer();
        assert_eq!(ring.len(), 1);
        assert_eq!(ring[0].scope, "renderer:view");
        assert_eq!(ring[0].msg, "hello");
        assert_eq!(ring[0].to_value()["n"], json!(1));
    }

    #[test]
    fn set_level_hand_rolled_shapes() {
        let (state, _guard) = test_state();
        assert_eq!(
            set_level_impl(&state, &[json!("debug")]),
            json!({ "success": true })
        );
        assert_eq!(state.logger.level(), LogLevel::Debug);
        assert_eq!(
            set_level_impl(&state, &[json!("verbose")]),
            json!({ "success": false, "error": "Invalid level" })
        );
        // Bad level leaves the current level untouched.
        assert_eq!(state.logger.level(), LogLevel::Debug);
        assert_eq!(
            get_level_impl(&state),
            json!({ "success": true, "data": "debug" })
        );
    }

    #[test]
    fn retention_clamps_and_roundtrips() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = set_retention_impl(&state, &[json!(0)], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true }));
        let current = get_retention_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(current, json!({ "success": true, "data": 1 }));
        set_retention_impl(&state, &[json!(9999)], &mut sink).expect("ok");
        assert_eq!(state.logger.retention_days(), 365);
    }

    #[test]
    fn get_records_returns_ring_json() {
        let (state, _guard) = test_state();
        state.logger.info("visible", None);
        let out = get_records_impl(&state).expect("ok");
        let records = out["data"].as_array().expect("records array");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["msg"], json!("visible"));
        assert!(records[0]["ts"].is_string());
    }

    /// Minimal tempdir guard (mirrors the app.rs tests; shared helper lands
    /// when the third namespace needs it).
    mod tempfile_guard {
        use std::path::{Path, PathBuf};
        pub struct Guard {
            path: PathBuf,
        }
        impl Guard {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "kopibon-log-cmd-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&path).expect("mkdir");
                Guard { path }
            }
            pub fn path(&self) -> &Path {
                &self.path
            }
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }
}
