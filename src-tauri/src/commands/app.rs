//! `app:*` commands (02-ipc-surface §2.10).
//!
//! `getVersion` is compile-time (`app.getVersion()` equivalent).
//! `checkToolchain` keeps the 1.x `ToolchainReport` shape (`{ok, tools[],
//! installHint}` — ToolchainStatus.tsx renders it generically) with 2.x-native
//! rows: there is nothing to install (D3), so the report lists the bundled
//! components and their status. A failed pdfium bind surfaces here as
//! `ok:false` with the loud error as detail — the loud-not-silent principle
//! in UI form. Cached unless `force` (toolchain.ts:105-106).

use serde_json::{json, Value};
use tauri::State;

use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// `app:getVersion` → version string (`index.ts:399`).
pub(crate) fn get_version_impl() -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": env!("CARGO_PKG_VERSION") }))
}

/// `app:checkToolchain` (`index.ts:237`) — `(force?)` → toolchain report.
pub(crate) fn check_toolchain_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let force = args.first().and_then(|v| v.as_bool()).unwrap_or(false);
    if !force {
        if let Ok(cache) = state.toolchain_cache.lock() {
            if let Some(report) = cache.clone() {
                return Ok(json!({ "success": true, "data": report }));
            }
        }
    }
    let report = build_report();
    state
        .toolchain_cache
        .lock()
        .map(|mut c| *c = Some(report.clone()))
        .ok();
    Ok(json!({ "success": true, "data": report }))
}

fn build_report() -> Value {
    let pdfium = match kopibon_core::conversion::raster::probe_library(None) {
        Ok(detail) => json!({
            "id": "pdfium",
            "name": "pdfium (bundled rasteriser)",
            "ok": true,
            "detail": detail,
            "affects": "Lossy PDF→CBZ fallback and PDF thumbnails.",
            "required": true,
        }),
        Err(error) => json!({
            "id": "pdfium",
            "name": "pdfium (bundled rasteriser)",
            "ok": false,
            "detail": error,
            "affects": "Lossy PDF→CBZ fallback and PDF thumbnails.",
            "required": true,
        }),
    };
    let sqlite = json!({
        "id": "sqlite",
        "name": "SQLite (bundled)",
        "ok": true,
        "detail": rusqlite::version(),
        "affects": "Library database.",
        "required": true,
    });
    let tools = vec![pdfium, sqlite];
    let ok = tools.iter().all(|t| t["ok"].as_bool().unwrap_or(false));
    json!({ "ok": ok, "tools": tools, "installHint": "" })
}

#[tauri::command(rename = "app:getVersion")]
pub(crate) fn app_get_version(_args: Vec<Value>) -> Value {
    let outcome = handle("app:getVersion", |_log| get_version_impl());
    // No state: nothing to forward to (a fast infallible command logs nothing).
    debug_assert!(outcome.logs.is_empty());
    outcome.value
}

#[tauri::command(rename = "app:checkToolchain")]
pub(crate) fn app_check_toolchain(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("app:checkToolchain", |log| {
        check_toolchain_impl(&state, &args, log)
    });
    forward(&state, "app:checkToolchain", outcome.logs);
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_state() -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "kopibon-app-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        AppState::open(dir).expect("scratch state")
    }

    #[test]
    fn get_version_reports_cargo_version() {
        let value = get_version_impl().expect("infallible");
        assert_eq!(
            value,
            json!({ "success": true, "data": env!("CARGO_PKG_VERSION") })
        );
    }

    #[test]
    fn check_toolchain_reports_bundled_components() {
        let state = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let value = check_toolchain_impl(&state, &[], &mut sink).expect("report builds");
        let data = &value["data"];
        assert_eq!(value["success"], json!(true));
        let tools = data["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["id"], json!("pdfium"));
        assert_eq!(tools[0]["ok"], json!(true));
        assert!(tools[0]["detail"]
            .as_str()
            .expect("detail")
            .contains("bundled"));
        assert_eq!(tools[1]["id"], json!("sqlite"));
        // Cached: a second call (no force) returns the identical report.
        let again = check_toolchain_impl(&state, &[], &mut sink).expect("cached report");
        assert_eq!(value, again);
        assert!(state.data_dir.exists());
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }
}
