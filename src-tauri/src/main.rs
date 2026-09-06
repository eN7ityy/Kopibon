#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Kopibon 2.x Tauri shell (Phase B).
//!
//! The React renderer is unchanged — `src/renderer/src/bridge.ts` rebuilds
//! the identical `window.api` over Tauri `invoke`/`listen`. B2's command
//! layer lives in `commands/` (one module per namespace) over `envelope.rs`
//! (the `handle.ts` port) and `events.rs`; B3 adds the plugins, bootstrap
//! parity and polls→push.

mod auth;
mod commands;
mod envelope;
mod events;
mod kavita;
mod log;
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app);
            let state = AppState::open(data_dir).map_err(|e| e.to_string())?;
            // `restoreAuthFromDb()` (`index.ts`): fire-and-forget, NOT awaited
            // — the window shows while the saved key validates. A scoped
            // logger line records the outcome; failures are silent by design
            // (an invalid saved key just means logged-out).
            let logger = state.logger.scope("auth");
            app.manage(state);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Manager;
                let state: tauri::State<AppState> = handle.state();
                let restored = state
                    .auth
                    .lock()
                    .map(|mut auth| {
                        auth.restore(&state.db);
                        auth.status()
                    })
                    .unwrap_or((false, None));
                if restored.0 {
                    logger.info("Restored saved API session", None);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::app::app_get_version,
            commands::app::app_check_toolchain,
            commands::log::log_write,
            commands::log::log_get_records,
            commands::log::log_set_level,
            commands::log::log_get_level,
            commands::log::log_set_retention,
            commands::log::log_get_retention,
            commands::auth::auth_validate_key,
            commands::auth::auth_get_auth_status,
            commands::auth::auth_set_key,
            commands::auth::auth_clear_key,
            commands::auth::auth_get_rate_limits,
            commands::settings::settings_get,
            commands::settings::settings_get_all,
            commands::settings::settings_set,
            commands::settings::settings_set_all,
            commands::settings::settings_delete,
            commands::shell::shell_open_external,
            commands::shell::shell_open_path,
            commands::shell::shell_show_item_in_folder,
            commands::shell::dialog_open_file,
            commands::shell::dialog_open_directory,
            commands::kavita::kavita_test_connection,
            commands::kavita::kavita_get_libraries,
            commands::kavita::kavita_get_item_count,
            commands::kavita::kavita_get_series_detail,
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
    debug_assert!(outcome.logs.is_empty());
    outcome.value
}
