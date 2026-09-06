//! `auth:*` commands (02-ipc-surface §2.2, `auth.ipc.ts:76-137`).
//!
//! Shapes: `validateKey` throws `'Invalid API key'` (envelope + errorId);
//! the rest succeed with `{success:true[, data]}`. `getRateLimits` is the
//! dead sibling (§4) — registered in main, exposed nowhere; the port
//! registers it too rather than dropping a main-side channel.

use serde_json::{json, Value};
use tauri::State;

use crate::auth::AuthState;
use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// `auth:validateKey` (`auth.ipc.ts:83-98`): `(key)` → `{username}`.
pub(crate) fn validate_key_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let mut auth = state
        .auth
        .lock()
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))?;
    match auth.validate_key(&state.db, key) {
        Ok(username) => Ok(json!({ "success": true, "data": { "username": username } })),
        Err(message) => Err(CommandError::Thrown(message)),
    }
}

/// `auth:getAuthStatus` (`auth.ipc.ts:103-105`): `()` → `{loggedIn,
/// username}`. `username` is OMITTED when unset — 1.x's `undefined` does
/// not survive structured clone, so the renderer only ever sees the key
/// present; `null` would be a new shape.
pub(crate) fn auth_status_impl(state: &AppState) -> Result<Value, CommandError> {
    let (logged_in, username) = current_status(state)?;
    let mut data = serde_json::Map::new();
    data.insert("loggedIn".to_string(), Value::Bool(logged_in));
    if let Some(username) = username {
        data.insert("username".to_string(), Value::String(username));
    }
    Ok(Value::Object(
        [
            (String::from("success"), Value::Bool(true)),
            (String::from("data"), Value::Object(data)),
        ]
        .into_iter()
        .collect(),
    ))
}

fn current_status(state: &AppState) -> Result<(bool, Option<String>), CommandError> {
    state
        .auth
        .lock()
        .map(|guard| AuthState::status(&guard))
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))
}

/// `auth:setKey` (`auth.ipc.ts:111-114`): `(key)` → bare `{success:true}`
/// (no `data` key — exactly like 1.x). No validation, no persistence.
pub(crate) fn set_key_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str()).unwrap_or("");
    state
        .auth
        .lock()
        .map(|mut guard| guard.set_key_unchecked(key))
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))?;
    Ok(json!({ "success": true }))
}

/// `auth:clearKey` (`auth.ipc.ts:120-127`).
pub(crate) fn clear_key_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state
        .auth
        .lock()
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))?
        .clear_key(&state.db)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true }))
}

/// `auth:getRateLimits` (`auth.ipc.ts:132-137`).
pub(crate) fn rate_limits_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let (authenticated, buckets) = state
        .auth
        .lock()
        .map(|mut guard| guard.rate_limits())
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))?;
    Ok(json!({ "success": true, "data": { "authenticated": authenticated, "buckets": buckets } }))
}

#[tauri::command(rename = "auth:validateKey")]
pub(crate) fn auth_validate_key(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("auth:validateKey", |log| {
        validate_key_impl(&state, &args, log)
    });
    forward(&state, "auth:validateKey", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "auth:getAuthStatus")]
pub(crate) fn auth_get_auth_status(state: State<AppState>, args: Vec<Value>) -> Value {
    let _ = &args;
    let outcome = handle("auth:getAuthStatus", |_log| auth_status_impl(&state));
    forward(&state, "auth:getAuthStatus", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "auth:setKey")]
pub(crate) fn auth_set_key(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("auth:setKey", |log| set_key_impl(&state, &args, log));
    forward(&state, "auth:setKey", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "auth:clearKey")]
pub(crate) fn auth_clear_key(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("auth:clearKey", |log| clear_key_impl(&state, &args, log));
    forward(&state, "auth:clearKey", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "auth:getRateLimits")]
pub(crate) fn auth_get_rate_limits(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("auth:getRateLimits", |log| {
        rate_limits_impl(&state, &args, log)
    });
    forward(&state, "auth:getRateLimits", outcome.logs);
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
                    "kopibon-auth-test-{}-{}",
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

    /// `setKey` arms without persisting: no `nhentai_api_key` row appears
    /// (`auth.ipc.ts:111-114` writes nothing to the DB).
    #[test]
    fn set_key_does_not_persist() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = set_key_impl(&state, &[json!("raw-key-abc")], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true }));
        let row = state
            .db
            .with_reader(|conn| kopibon_core::db::settings::get(conn, "nhentai_api_key"))
            .expect("read");
        assert_eq!(row, None);
    }

    /// `getAuthStatus` starts logged-out with NO username key (structured-
    /// clone drops `undefined` — `null` would be a new shape).
    #[test]
    fn status_starts_logged_out_without_username() {
        let (state, _guard) = test_state();
        let out = auth_status_impl(&state).expect("ok");
        assert_eq!(
            out,
            json!({ "success": true, "data": { "loggedIn": false } })
        );
    }

    /// `clearKey` on a logged-out state still succeeds and removes the row.
    #[test]
    fn clear_key_is_idempotent() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = clear_key_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true }));
        let (logged_in, _) = current_status(&state).expect("status");
        assert!(!logged_in);
    }

    /// `getRateLimits` reports the anonymous tiers with `authenticated:false`.
    #[test]
    fn rate_limits_shape() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let out = rate_limits_impl(&state, &[], &mut sink).expect("ok");
        let data = &out["data"];
        assert_eq!(data["authenticated"], json!(false));
        assert!(data["buckets"].is_object());
    }
}
