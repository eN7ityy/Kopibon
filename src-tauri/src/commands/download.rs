//! `download:*` commands (02-ipc-surface §2.5, `download.ipc.ts:8-117`).
//!
//! Queue reads/writes go straight to `db::download`; control goes through
//! the shell [`DownloadManager`](crate::download::DownloadManager).
//! Shapes: `pause`/`resume`/`cancel` return the bare manager result as
//! `success` (`{success: bool}` — no `data`, no `errorId`, `:82-95`);
//! everything else is the usual envelope.

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::auth::stored_setting;
use crate::download::resolve_output_format;
use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// `download:getAll` (`download.ipc.ts:19-22`).
pub(crate) fn get_all_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let items = state
        .db
        .with_reader(kopibon_core::db::download::find_all)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": items }))
}

/// `download:getById` (`:24-27`): row or null.
pub(crate) fn get_by_id_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::download::find_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": item }))
}

/// `download:getByStatus` (`:29-32`).
pub(crate) fn get_by_status_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let status = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let items = state
        .db
        .with_reader(|conn| kopibon_core::db::download::find_by_status(conn, status))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": items }))
}

/// `download:getByGalleryId` (`:34-37`): row or null (never undefined —
/// the `?? null` is load-bearing for the renderer's cache check).
pub(crate) fn get_by_gallery_id_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let gallery_id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::download::find_by_gallery_id(conn, gallery_id))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": item }))
}

/// `download:addToQueue` (`:39-73`): dedupe on the active row for the
/// gallery (`{id, duplicate: true}`), else explicit format → setting →
/// default, insert, and kick the pump.
pub(crate) fn add_to_queue_impl(
    state: &AppState,
    app: &AppHandle,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let gallery_id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let output_format = args.get(1).and_then(|v| v.as_str());
    let output_directory = args.get(2).and_then(|v| v.as_str());
    if let Some(existing) = state
        .db
        .with_reader(|conn| kopibon_core::db::download::find_active_by_gallery_id(conn, gallery_id))
        .map_err(CommandError::Thrown)?
    {
        let id = existing.get("id").and_then(Value::as_i64).unwrap_or(0);
        return Ok(json!({ "success": true, "data": { "id": id, "duplicate": true } }));
    }
    let format = resolve_output_format(
        output_format,
        stored_setting(&state.db, "outputFormat").as_deref(),
    );
    let id = state
        .db
        .with_writer(|conn| {
            kopibon_core::db::download::insert(conn, gallery_id, &format, Some(0), output_directory)
        })
        .map_err(CommandError::Thrown)?;
    state.download.kick(app);
    Ok(json!({ "success": true, "data": { "id": id } }))
}

/// `download:remove` (`:75-79`): cancel in-flight, delete row + pages.
pub(crate) fn remove_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    state.download.cancel_download(&state.db, id);
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::download::delete(conn, id)?;
            kopibon_core::db::download::delete_pages(conn, id)
        })
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true }))
}

/// `download:pause` (`:82-85`): the envelope `success` IS the result.
pub(crate) fn pause_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({ "success": state.download.pause_download(&state.db, id) }))
}

/// `download:resume` (`:87-90`).
pub(crate) fn resume_impl(
    state: &AppState,
    app: &AppHandle,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({ "success": state.download.resume_download(app, &state.db, id) }))
}

/// `download:cancel` (`:92-95`).
pub(crate) fn cancel_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({ "success": state.download.cancel_download(&state.db, id) }))
}

/// `download:pauseAll` (`:97-100`).
pub(crate) fn pause_all_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.download.pause_all(&state.db);
    Ok(json!({ "success": true }))
}

/// `download:resumeAll` (`:102-105`).
pub(crate) fn resume_all_impl(
    state: &AppState,
    app: &AppHandle,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.download.resume_all(app, &state.db);
    Ok(json!({ "success": true }))
}

/// `download:getPages` (`:107-110`).
pub(crate) fn get_pages_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let queue_id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let pages = state
        .db
        .with_reader(|conn| kopibon_core::db::download::get_pages(conn, queue_id))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": pages }))
}

/// `download:getStatusCounts` (`:112-116`): sidebar badges.
pub(crate) fn status_counts_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let (active, queued) = state
        .db
        .with_reader(kopibon_core::db::download::status_counts)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": { "active": active, "queued": queued } }))
}

macro_rules! download_command {
    ($fn_name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $fn_name(state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
    ($fn_name:ident, $channel:literal, $impl_fn:ident, app) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $fn_name(app: AppHandle, state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &app, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

download_command!(download_get_all, "download:getAll", get_all_impl);
download_command!(download_get_by_id, "download:getById", get_by_id_impl);
download_command!(
    download_get_by_status,
    "download:getByStatus",
    get_by_status_impl
);
download_command!(
    download_get_by_gallery_id,
    "download:getByGalleryId",
    get_by_gallery_id_impl
);
download_command!(
    download_add_to_queue,
    "download:addToQueue",
    add_to_queue_impl,
    app
);
download_command!(download_remove, "download:remove", remove_impl);
download_command!(download_pause, "download:pause", pause_impl);
download_command!(download_resume, "download:resume", resume_impl, app);
download_command!(download_cancel, "download:cancel", cancel_impl);
download_command!(download_pause_all, "download:pauseAll", pause_all_impl);
download_command!(
    download_resume_all,
    "download:resumeAll",
    resume_all_impl,
    app
);
download_command!(download_get_pages, "download:getPages", get_pages_impl);
download_command!(
    download_get_status_counts,
    "download:getStatusCounts",
    status_counts_impl
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::DownloadManager;

    mod tempfile_guard {
        pub struct Guard {
            dir: std::path::PathBuf,
        }
        impl Guard {
            pub fn new() -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "kopibon-download-cmd-test-{}-{}",
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

    fn insert_queued(state: &AppState, gallery_id: i64) -> i64 {
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::download::insert(conn, gallery_id, "cbz", Some(0), None)
            })
            .expect("insert")
    }

    /// Queue reads + counts on a scratch DB.
    #[test]
    fn queue_reads_and_counts() {
        let (state, _guard) = test_state();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let id = insert_queued(&state, 111);
        let out = get_all_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            get_by_id_impl(&state, &[json!(id)], &mut sink).expect("ok")["data"]["gallery_id"],
            json!(111)
        );
        assert_eq!(
            get_by_gallery_id_impl(&state, &[json!(111)], &mut sink).expect("ok")["data"]["id"],
            json!(id)
        );
        assert_eq!(
            get_by_gallery_id_impl(&state, &[json!(999)], &mut sink).expect("ok")["data"],
            Value::Null
        );
        let out = status_counts_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"], json!({ "active": 0, "queued": 1 }));
    }

    /// Pause/resume/cancel shapes: bare `{success: bool}` from the
    /// manager result, with the DB transitions behind them.
    #[test]
    fn pause_resume_cancel_shapes() {
        let (state, _guard) = test_state();
        let manager = DownloadManager::new();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let id = insert_queued(&state, 222);
        // Pause a queued row → true; again → false.
        assert!(manager.pause_download(&state.db, id));
        assert!(!manager.pause_download(&state.db, id));
        // Resume a paused row → 'queued' again (the AppHandle kick is
        // covered by review — resume_download only kicks on success).
        let resumed = state
            .db
            .with_writer(|conn| kopibon_core::download::resume_paused(conn, id))
            .expect("resume");
        assert!(resumed);
        // Cancel a queued row → true + row gone; again → false.
        assert!(manager.cancel_download(&state.db, id));
        let gone = state
            .db
            .with_reader(|conn| kopibon_core::db::download::find_by_id(conn, id))
            .expect("read");
        assert_eq!(gone, None);
        assert!(!manager.cancel_download(&state.db, id));
        // pause/resume/cancel impls return the bare manager result.
        let out = pause_impl(&state, &[json!(id)], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": false }));
        let _ = sink;
    }

    /// pauseAll/resumeAll sweep rows; remove deletes row + pages.
    #[test]
    fn pause_all_resume_all_remove() {
        let (state, _guard) = test_state();
        let manager = DownloadManager::new();
        let mut sink = |_: crate::envelope::LogRecord| {};
        let a = insert_queued(&state, 1);
        insert_queued(&state, 2);
        manager.pause_all(&state.db);
        let out = status_counts_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"], json!({ "active": 0, "queued": 2 }));
        state
            .db
            .with_writer(|conn| kopibon_core::download::resume_all(conn))
            .expect("resumeAll");
        let out = get_by_status_impl(&state, &[json!("queued")], &mut sink).expect("ok");
        assert_eq!(out["data"].as_array().map(Vec::len), Some(2));
        let out = remove_impl(&state, &[json!(a)], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true }));
        let out = get_pages_impl(&state, &[json!(a)], &mut sink).expect("ok");
        assert_eq!(out["data"].as_array().map(Vec::len), Some(0));
    }
}
