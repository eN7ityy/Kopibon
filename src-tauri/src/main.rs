#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Kopibon 2.x Tauri shell (Phase B).
//!
//! The React renderer is unchanged — `src/renderer/src/bridge.ts` rebuilds
//! the identical `window.api` over Tauri `invoke`/`listen`. B2's command
//! layer lives in `commands/` (one module per namespace) over `envelope.rs`
//! (the `handle.ts` port) and `events.rs`; B3 adds the plugins, bootstrap
//! parity and polls→push.

mod commands;
mod envelope;
mod events;
mod state;

use state::AppState;
use tauri::Manager;

/// Resolve the data dir: `KOPIBON_DATA_DIR` wins (scratch dirs for Phase B
/// runs, the differential harness convention — `src/main/index.ts:101`),
/// otherwise the Tauri app-data path (the `app.getPath('userData')`
/// equivalent).
fn resolve_data_dir(app: &tauri::App) -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("KOPIBON_DATA_DIR") {
        if !dir.is_empty() {
            return dir.into();
        }
    }
    app.path()
        .app_data_dir()
        .expect("tauri app data dir resolves")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = resolve_data_dir(app);
            let state = AppState::open(data_dir).map_err(|e| e.to_string())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::app::app_get_version,
            commands::app::app_check_toolchain,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run kopibon");
}

/// Scaffold smoke command (B1): proves the invoke loop end to end. Deleted
/// once B2's contract suite drives the real channels.
#[tauri::command]
fn ping() -> serde_json::Value {
    let outcome = envelope::handle("ping", |_log| {
        Ok(serde_json::json!({ "success": true, "data": "pong" }))
    });
    envelope::forward_to_stderr(&outcome.logs);
    outcome.value
}
