//! Updater (`src/main/ipc/updater.ipc.ts`).
//!
//! `tauri-plugin-updater` against the GitHub-release feed. Feed endpoints
//! and pubkey are release-plan wiring. Until that lands, every check errors
//! and the status is `{state:'error'}` — the same shape 1.x shows without
//! publish config.
//!
//! `autoDownload=false` is structural here: check only checks, while
//! download and install stay separate explicit user actions.
//!
//! The status is cached for late mounters (`getUpdateStatus` yields null
//! before the first event) and broadcast as `app:updateStatus` to all
//! windows.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::auth::stored_setting;
use crate::envelope::{handle, CommandError, LogSink};
use crate::events::emit;
use crate::state::AppState;

use super::forward;

/// Release channel (`updater.ipc.ts:45-51`): stored `stable`/`beta` wins;
/// otherwise a beta build opts itself in by version match (one-time
/// default, persisted so the migration doesn't re-fire).
pub fn release_channel(state: &AppState) -> String {
    let stored = stored_setting(&state.db, "releaseChannel").unwrap_or_default();
    if stored == "stable" || stored == "beta" {
        return stored;
    }
    let inferred = if env!("CARGO_PKG_VERSION").contains("beta") {
        "beta"
    } else {
        "stable"
    };
    let _ = state
        .db
        .with_writer(|conn| kopibon_core::db::settings::set(conn, "releaseChannel", inferred));
    inferred.to_string()
}

/// Whether a remote release is an update for the channel
/// (`allowPrerelease` semantics): stable skips prereleases, beta takes
/// anything newer. Invalid current version → nothing is an update.
fn is_update_for_channel(current: &str, remote: &semver::Version, channel: &str) -> bool {
    let Ok(current) = semver::Version::parse(current) else {
        return false;
    };
    if remote <= &current {
        return false;
    }
    if channel == "beta" {
        return true;
    }
    remote.pre.is_empty()
}

/// Updater shell state: cached status + staged update.
pub struct UpdaterState {
    status: Mutex<Option<Value>>,
    staged: Mutex<Option<StagedUpdate>>,
}

struct StagedUpdate {
    update: tauri_plugin_updater::Update,
    downloaded: bool,
}

impl UpdaterState {
    pub fn new() -> Self {
        UpdaterState {
            status: Mutex::new(None),
            staged: Mutex::new(None),
        }
    }

    pub fn status(&self) -> Option<Value> {
        self.status.lock().ok().and_then(|guard| guard.clone())
    }
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self::new()
    }
}

/// Cache + broadcast (`sendUpdateStatus`, `:74-79`).
fn set_status(app: &AppHandle, state: &AppState, payload: Value) {
    if let Ok(mut guard) = state.updater.status.lock() {
        *guard = Some(payload.clone());
    }
    emit(app, "app:updateStatus", payload);
}

/// Run one update check, updating the cached/broadcast status. Returns the
/// `checkForUpdates` data (`{version}` or null).
fn run_check(app: &AppHandle, state: &AppState) -> Option<Value> {
    set_status(app, state, json!({ "state": "checking" }));
    let channel = release_channel(state);
    let builder = app
        .updater_builder()
        .version_comparator(move |current, remote| {
            is_update_for_channel(&current.to_string(), &remote.version, &channel)
        });
    let updater = match builder.build() {
        Ok(updater) => updater,
        Err(e) => {
            set_status(
                app,
                state,
                json!({ "state": "error", "message": e.to_string() }),
            );
            return None;
        }
    };
    match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(update)) => {
            let version = update.version.clone();
            // Release notes arrive as a plain string (`body`) — the
            // array-of-notes shape was electron-updater's
            // (`releaseNotesText`, `:25-35`); empty stays null.
            let release_notes = update
                .body
                .clone()
                .filter(|text| !text.is_empty())
                .map(Value::String)
                .unwrap_or(Value::Null);
            if let Ok(mut guard) = state.updater.staged.lock() {
                *guard = Some(StagedUpdate {
                    update,
                    downloaded: false,
                });
            }
            let mut payload = serde_json::Map::new();
            payload.insert("state".to_string(), json!("available"));
            payload.insert("version".to_string(), json!(version));
            payload.insert("releaseNotes".to_string(), release_notes);
            set_status(app, state, Value::Object(payload));
            state.logger.scope("updater").info(
                "Update available",
                Some({
                    let mut fields = serde_json::Map::new();
                    fields.insert("version".to_string(), json!(version));
                    fields
                }),
            );
            Some(json!({ "version": version }))
        }
        Ok(None) => {
            set_status(app, state, json!({ "state": "current" }));
            None
        }
        Err(e) => {
            let message = e.to_string();
            state.logger.scope("updater").error(
                "Auto-updater error",
                Some({
                    let mut fields = serde_json::Map::new();
                    fields.insert("message".to_string(), json!(&message));
                    fields
                }),
            );
            set_status(app, state, json!({ "state": "error", "message": message }));
            None
        }
    }
}

/// `refreshReleaseChannel` (`:62-67`, called from settings when
/// `releaseChannel` is saved): re-apply + check immediately, fire-and-
/// forget — failures surface via the status event, never the save.
pub fn refresh_release_channel(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state: tauri::State<AppState> = app.state();
        run_check(&app, &state);
    });
}

/// `app:checkForUpdates` (`:126-132`).
pub(crate) fn check_for_updates_impl(
    state: &AppState,
    app: &AppHandle,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": run_check(app, state) }))
}

/// `app:downloadUpdate` (`:142-145`): explicit user action only.
pub(crate) fn download_update_impl(
    state: &AppState,
    app: &AppHandle,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let staged = state
        .updater
        .staged
        .lock()
        .map_err(|_| CommandError::Thrown("updater lock poisoned".to_string()))?
        .take();
    let Some(mut staged) = staged else {
        return Err(CommandError::Thrown(
            "No update available to download".to_string(),
        ));
    };
    let version = staged.update.version.clone();
    let app_for_progress = app.clone();
    let result = tauri::async_runtime::block_on(staged.update.download(
        move |downloaded, total| {
            let percent = total
                .filter(|total| *total > 0)
                .map(|total| ((downloaded as f64 / total as f64) * 100.0).round() as i64)
                .unwrap_or(0);
            let _ = app_for_progress.emit(
                "app:updateStatus",
                json!({ "state": "downloading", "percent": percent }),
            );
        },
        || {},
    ));
    match result {
        Ok(bytes) => {
            if let Err(e) = staged.update.install(bytes) {
                set_status(
                    app,
                    state,
                    json!({ "state": "error", "message": e.to_string() }),
                );
                return Err(CommandError::Thrown(e.to_string()));
            }
            staged.downloaded = true;
            let version_clone = version.clone();
            if let Ok(mut guard) = state.updater.staged.lock() {
                *guard = Some(staged);
            }
            set_status(app, state, json!({ "state": "ready", "version": version }));
            state.logger.scope("updater").info(
                "Update downloaded",
                Some({
                    let mut fields = serde_json::Map::new();
                    fields.insert("version".to_string(), json!(version_clone));
                    fields
                }),
            );
            Ok(json!({ "success": true }))
        }
        Err(e) => {
            set_status(
                app,
                state,
                json!({ "state": "error", "message": e.to_string() }),
            );
            Err(CommandError::Thrown(e.to_string()))
        }
    }
}

/// `app:installUpdate` (`:135-139`): `quitAndInstall(false, true)` —
/// restart after installing. No-op unless an update was downloaded.
pub(crate) fn install_update_impl(
    state: &AppState,
    app: &AppHandle,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let downloaded = state
        .updater
        .staged
        .lock()
        .map_err(|_| CommandError::Thrown("updater lock poisoned".to_string()))?
        .as_ref()
        .map(|staged| staged.downloaded)
        .unwrap_or(false);
    if downloaded {
        app.restart();
    }
    Ok(json!({ "success": true }))
}

/// `app:getUpdateStatus` (`:148`): cached status, null before the first.
pub(crate) fn get_update_status_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": state.updater.status() }))
}

#[tauri::command(rename = "app:checkForUpdates")]
pub(crate) fn app_check_for_updates(
    app: AppHandle,
    state: tauri::State<AppState>,
    args: Vec<Value>,
) -> Value {
    let outcome = handle("app:checkForUpdates", |log| {
        check_for_updates_impl(&state, &app, &args, log)
    });
    forward(&state, "app:checkForUpdates", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "app:downloadUpdate")]
pub(crate) fn app_download_update(
    app: AppHandle,
    state: tauri::State<AppState>,
    args: Vec<Value>,
) -> Value {
    let outcome = handle("app:downloadUpdate", |log| {
        download_update_impl(&state, &app, &args, log)
    });
    forward(&state, "app:downloadUpdate", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "app:installUpdate")]
pub(crate) fn app_install_update(
    app: AppHandle,
    state: tauri::State<AppState>,
    args: Vec<Value>,
) -> Value {
    let outcome = handle("app:installUpdate", |log| {
        install_update_impl(&state, &app, &args, log)
    });
    forward(&state, "app:installUpdate", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "app:getUpdateStatus")]
pub(crate) fn app_get_update_status(state: tauri::State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("app:getUpdateStatus", |log| {
        get_update_status_impl(&state, &args, log)
    });
    forward(&state, "app:getUpdateStatus", outcome.logs);
    outcome.value
}

/// Startup check (`registerUpdaterIpc`, `:152-154`): fire-and-forget, the
/// error event carries failures. Call with the app handle after manage.
pub fn startup_check(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state: tauri::State<AppState> = app.state();
        run_check(&app, &state);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Channel comparator: stable skips prereleases, beta takes anything
    /// newer, nothing older ever qualifies.
    #[test]
    fn channel_comparator() {
        let remote = |version: &str| semver::Version::parse(version).expect("fixture");
        assert!(is_update_for_channel("1.0.2", &remote("1.0.3"), "stable"));
        assert!(!is_update_for_channel("1.0.2", &remote("1.0.2"), "stable"));
        assert!(!is_update_for_channel("1.0.2", &remote("1.0.1"), "stable"));
        assert!(!is_update_for_channel(
            "1.0.2",
            &remote("1.1.0-beta.1"),
            "stable"
        ));
        assert!(is_update_for_channel(
            "1.0.2",
            &remote("1.1.0-beta.1"),
            "beta"
        ));
        assert!(is_update_for_channel("1.0.2", &remote("1.0.3"), "beta"));
        assert!(!is_update_for_channel("bogus", &remote("9.9.9"), "beta"));
    }
}
