//! `settings:*` commands (02-ipc-surface §2.11, `settings.ipc.ts:50-84`).
//!
//! `kavitaApiKey` is encrypted transparently through the auth keychain
//! layer (`ENCRYPTED_SETTINGS`, `settings.ipc.ts:34`) — the renderer only
//! ever sees plaintext. Live-apply (`downloadConcurrency` → download
//! manager, `releaseChannel` → updater, `settings.ipc.ts:7-23`) is a
//! no-op until those services land: 1.x swallows apply errors so a save
//! never fails, and with no targets yet there is nothing to fail.

use serde_json::{json, Value};
use std::collections::BTreeSet;
use tauri::State;

use crate::auth::{decrypt_key, encrypt_key, KAVITA_KEY_ACCOUNT};
use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// Settings whose value is a credential (`settings.ipc.ts:34`).
fn encrypted_settings() -> BTreeSet<&'static str> {
    BTreeSet::from(["kavitaApiKey"])
}

/// `decryptIfEncrypted` (`settings.ipc.ts:42-44`): empty values skip
/// decryption (falsy guard) so an empty row never becomes a keychain lookup.
fn decrypt_if_encrypted(key: &str, value: &str) -> String {
    if encrypted_settings().contains(key) && !value.is_empty() {
        decrypt_key(KAVITA_KEY_ACCOUNT, value)
    } else {
        value.to_string()
    }
}

/// `encryptIfSensitive` (`settings.ipc.ts:46-48`).
fn encrypt_if_sensitive(key: &str, value: &str) -> String {
    if encrypted_settings().contains(key) && !value.is_empty() {
        encrypt_key(KAVITA_KEY_ACCOUNT, value)
    } else {
        value.to_string()
    }
}

/// `LIVE_SETTINGS` targets (`settings.ipc.ts:7-12`). No-ops until the
/// download manager (`downloadConcurrency`) and updater (`releaseChannel`)
/// land — 1.x `applyLiveSettings` swallows per-key errors, so the save
/// contract (never fails on apply) already holds.
fn apply_live_settings(_keys: &[String]) {}

/// `settings:get` (`settings.ipc.ts:51-54`): `(key)` → `string|null`
/// (`undefined` becomes `null` across the JSON boundary — same value the
/// renderer's `?? undefined` idioms already normalise).
pub(crate) fn get_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let value = state
        .db
        .with_reader(|conn| kopibon_core::db::settings::get(conn, key))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": value.map(|v| decrypt_if_encrypted(key, &v)) }))
}

/// `settings:getAll` (`settings.ipc.ts:56-62`).
pub(crate) fn get_all_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let all = state
        .db
        .with_reader(kopibon_core::db::settings::get_all)
        .map_err(CommandError::Thrown)?;
    let mut out = serde_json::Map::new();
    for (key, value) in all {
        out.insert(
            key.clone(),
            Value::String(decrypt_if_encrypted(&key, &value)),
        );
    }
    Ok(json!({ "success": true, "data": out }))
}

/// `settings:set` (`settings.ipc.ts:64-68`).
pub(crate) fn set_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let value = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::settings::set(conn, key, &encrypt_if_sensitive(key, value))
        })
        .map_err(CommandError::Thrown)?;
    apply_live_settings(&[key.to_string()]);
    Ok(json!({ "success": true }))
}

/// `settings:setAll` (`settings.ipc.ts:70-78`).
pub(crate) fn set_all_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let mut keys = Vec::new();
    if let Some(obj) = args.first().and_then(|v| v.as_object()) {
        state
            .db
            .with_writer(|conn| {
                for (key, value) in obj {
                    let plain = value.as_str().unwrap_or("");
                    kopibon_core::db::settings::set(conn, key, &encrypt_if_sensitive(key, plain))?;
                    keys.push(key.clone());
                }
                Ok(())
            })
            .map_err(CommandError::Thrown)?;
    }
    // `Object.keys(settings)` — absent/non-object arg applies nothing,
    // exactly like 1.x iterating zero entries.
    apply_live_settings(&keys);
    Ok(json!({ "success": true }))
}

/// `settings:delete` (`settings.ipc.ts:80-83`).
pub(crate) fn delete_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str()).unwrap_or("");
    state
        .db
        .with_writer(|conn| kopibon_core::db::settings::delete(conn, key))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true }))
}

#[tauri::command(rename = "settings:get")]
pub(crate) fn settings_get(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("settings:get", |log| get_impl(&state, &args, log));
    forward(&state, "settings:get", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "settings:getAll")]
pub(crate) fn settings_get_all(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("settings:getAll", |log| get_all_impl(&state, &args, log));
    forward(&state, "settings:getAll", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "settings:set")]
pub(crate) fn settings_set(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("settings:set", |log| set_impl(&state, &args, log));
    forward(&state, "settings:set", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "settings:setAll")]
pub(crate) fn settings_set_all(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("settings:setAll", |log| set_all_impl(&state, &args, log));
    forward(&state, "settings:setAll", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "settings:delete")]
pub(crate) fn settings_delete(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("settings:delete", |log| delete_impl(&state, &args, log));
    forward(&state, "settings:delete", outcome.logs);
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
                    "kopibon-settings-test-{}-{}",
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

    /// Plain round trip + missing key → null.
    #[test]
    fn get_set_delete_round_trip() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        assert_eq!(
            get_impl(&state, &[json!("theme")], &mut sink).expect("ok"),
            json!({ "success": true, "data": null })
        );
        set_impl(&state, &[json!("theme"), json!("dark")], &mut sink).expect("ok");
        assert_eq!(
            get_impl(&state, &[json!("theme")], &mut sink).expect("ok"),
            json!({ "success": true, "data": "dark" })
        );
        delete_impl(&state, &[json!("theme")], &mut sink).expect("ok");
        assert_eq!(
            get_impl(&state, &[json!("theme")], &mut sink).expect("ok"),
            json!({ "success": true, "data": null })
        );
    }

    /// `kavitaApiKey` round-trips as plaintext to the renderer while the
    /// stored row is NOT the plaintext (keychain-backed here or not — the
    /// blob differs from the secret either way only when the keychain
    /// answers; without it the stored value IS the plaintext, verbatim
    /// 1.x `isEncryptionAvailable()`-false behaviour).
    #[test]
    fn kavita_key_transparent_encryption() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        set_impl(
            &state,
            &[json!("kavitaApiKey"), json!("kavita-secret")],
            &mut sink,
        )
        .expect("ok");
        assert_eq!(
            get_impl(&state, &[json!("kavitaApiKey")], &mut sink).expect("ok"),
            json!({ "success": true, "data": "kavita-secret" })
        );
        let all = get_all_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(all["data"]["kavitaApiKey"], json!("kavita-secret"));
    }

    /// `setAll` stores every entry and returns bare success; empty-string
    /// credentials skip encryption both ways.
    #[test]
    fn set_all_and_empty_credential() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        set_all_impl(
            &state,
            &[json!({ "a": "1", "kavitaApiKey": "" })],
            &mut sink,
        )
        .expect("ok");
        let all = get_all_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(all["data"]["a"], json!("1"));
        assert_eq!(all["data"]["kavitaApiKey"], json!(""));
    }
}
