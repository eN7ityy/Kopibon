#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Kopibon 2.x Tauri shell (Phase B).
//!
//! The React renderer is unchanged — `src/renderer/src/bridge.ts` rebuilds
//! the identical `window.api` over Tauri `invoke`/`listen`. B2's command
//! layer lives in `commands/` (one module per namespace) over `envelope.rs`
//! (the `handle.ts` port) and `events.rs`; B3 adds the plugins, bootstrap
//! parity and polls→push.

mod api;
mod auth;
mod commands;
mod diagnostics;
mod download;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
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
            // Updater startup check (`registerUpdaterIpc`, :152-154):
            // fire-and-forget, failures surface via the status event.
            commands::updater::startup_check(app.handle());
            // Download reconcile + resume (`index.ts` boot: reconcile
            // interrupted rows, apply concurrency, process the queue).
            {
                use tauri::Manager;
                let state: tauri::State<AppState> = app.state();
                state.download.startup(app.handle(), &state);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::api::api_search,
            commands::api::api_get_latest,
            commands::api::api_get_popular,
            commands::api::api_get_gallery,
            commands::api::api_get_cdn_config,
            commands::api::api_get_config,
            commands::api::api_set_api_key,
            commands::api::api_get_favorites,
            commands::api::api_get_user,
            commands::api::api_get_related_galleries,
            commands::api::api_add_favorite,
            commands::api::api_remove_favorite,
            commands::api::tags_autocomplete,
            commands::search::search_settings_get,
            commands::search::search_settings_set,
            commands::search::search_settings_build_query,
            commands::search::tags_resolve_for_galleries,
            commands::search::search_evaluate_results,
            commands::search::blocked_list,
            commands::search::blocked_add,
            commands::search::blocked_set_mode,
            commands::search::blocked_remove,
            commands::search::tags_cache_stats,
            commands::download::download_get_all,
            commands::download::download_get_by_id,
            commands::download::download_get_by_status,
            commands::download::download_get_by_gallery_id,
            commands::download::download_add_to_queue,
            commands::download::download_remove,
            commands::download::download_pause,
            commands::download::download_resume,
            commands::download::download_cancel,
            commands::download::download_pause_all,
            commands::download::download_resume_all,
            commands::download::download_get_pages,
            commands::download::download_get_status_counts,
            commands::app::app_get_version,
            commands::app::app_check_toolchain,
            commands::updater::app_check_for_updates,
            commands::updater::app_download_update,
            commands::updater::app_install_update,
            commands::updater::app_get_update_status,
            commands::log::log_write,
            commands::log::log_get_records,
            commands::log::log_set_level,
            commands::log::log_get_level,
            commands::log::log_set_retention,
            commands::log::log_get_retention,
            commands::log::log_open_folder,
            commands::log::log_export_diagnostics,
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
