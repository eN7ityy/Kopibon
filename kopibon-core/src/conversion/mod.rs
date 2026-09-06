//! Conversion pipeline port (convert-cbz.worker.ts + pdf-extract.ts + the
//! queue pump in library.ipc.ts:2929-3379) — 06-subsystem-plans.
//!
//! **The 8-step order of the worker is the safety property** (worker header,
//! 06 §3): source check → extract → metadata → generate → verify → original
//! handling → scratch purge → report. Failure at any step leaves the source
//! PDF and the DB row untouched — an invariant, not a courtesy.
//!
//! The lossy `pdftoppm` fallback is superseded by the USER DECISION of 06 §4:
//! until a rasteriser is chosen (escalation outstanding), a lossy fallback
//! raises a loud per-item error and the original is never touched.

pub mod extract;
pub mod metadata_job;
pub mod originals;
pub mod verify;
pub mod worker_cbz;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::metadata::mappers::Clock;

/// Claim the next pending conversion row (conversion.repo.ts:69-88 — the
/// RETURNING pattern; N runners are genuine here, unlike downloads).
pub fn claim_next(conn: &mut Connection) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "UPDATE conversion_queue
         SET status = 'converting'
         WHERE id = (
           SELECT id FROM conversion_queue WHERE status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1
         ) AND status = 'pending'
         RETURNING id, file_path",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// markCompleted (conversion.repo.ts:114-118).
pub fn mark_completed(conn: &Connection, id: i64, now_s: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE conversion_queue
         SET status = 'completed', completed_at = ?, error_message = NULL WHERE id = ?",
        rusqlite::params![now_s, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// markFailed (conversion.repo.ts:100-110) — 2000-char error truncation.
pub fn mark_failed(conn: &Connection, id: i64, error: &str) -> Result<(), String> {
    let error = if error.len() > 2000 { &error[..2000] } else { error };
    conn.execute(
        "UPDATE conversion_queue SET status = 'failed', error_message = ? WHERE id = ?",
        rusqlite::params![error, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// release (conversion.repo.ts:120-131): back to pending on cancel.
pub fn release(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE conversion_queue SET status = 'pending' WHERE id = ?",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// clearFinished (conversion.repo.ts:152-156): fresh (non-resume) batches
/// only.
pub fn clear_finished(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM conversion_queue WHERE status IN ('completed', 'failed')", [])
        .map_err(|e| e.to_string())
}

/// The library row a claimed queue row refers to, as the worker command
/// carries it (library.ipc.ts:3136-3148).
#[derive(Debug, Clone)]
pub struct ConvertItem {
    pub queue_id: Option<i64>,
    pub item_id: i64,
    pub file_path: String,
    pub gallery_id: Option<i64>,
    pub primary_artist: String,
    pub custom_title: Option<String>,
    pub custom_tags: Option<String>,
    pub custom_language: Option<String>,
    pub custom_date: Option<String>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub upload_date: Option<i64>,
    pub raw_tags_json: Option<String>,
}

pub fn fetch_item(conn: &Connection, file_path: &str) -> Result<Option<ConvertItem>, String> {
    conn.query_row(
        "SELECT li.id, li.file_path, li.gallery_id, li.primary_artist, li.custom_title,
                li.custom_tags, li.custom_language, li.custom_date, li.series_name,
                li.series_index, li.publisher, li.language, li.description,
                g.upload_date, g.raw_tags_json
         FROM library_item li LEFT JOIN gallery g ON g.id = li.gallery_id
         WHERE li.file_path = ?",
        [file_path],
        |r| {
            Ok(ConvertItem {
                queue_id: None,
                item_id: r.get(0)?,
                file_path: r.get(1)?,
                gallery_id: r.get(2)?,
                primary_artist: r.get(3)?,
                custom_title: r.get(4)?,
                custom_tags: r.get(5)?,
                custom_language: r.get(6)?,
                custom_date: r.get(7)?,
                series_name: r.get(8)?,
                series_index: r.get(9)?,
                publisher: r.get(10)?,
                language: r.get(11)?,
                description: r.get(12)?,
                upload_date: r.get(13)?,
                raw_tags_json: r.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// One worker run — the 8 ordered steps. Returns the done message on success.
/// Failure: Err with the message; source PDF and DB row untouched.
#[allow(clippy::too_many_arguments)]
pub fn convert_one(
    conn: &mut Connection,
    item: &ConvertItem,
    options: &worker_cbz::ConvertOptions<'_>,
    clock: &dyn Clock,
    log: &mut dyn FnMut(String),
) -> Result<Value, String> {
    let outcome = worker_cbz::convert_to_cbz(item, options, clock, log)?;

    // Completion (library.ipc.ts:3218-3261): cover rename, recount, row
    // update with both cover columns, then markCompleted.
    let new_rel = crate::download::relativize_library_path(
        std::path::Path::new(&outcome.new_path),
        options.library_root,
    );

    // Cover thumbnail rename to the new name, both columns kept in step.
    if let Some(gid) = item.gallery_id {
        let old_cover: Option<String> = conn
            .query_row(
                "SELECT custom_cover_path FROM library_item WHERE id = ?",
                [item.item_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if let (Some(old), Some(thumb_dir)) = (&old_cover, options.thumbnail_dir) {
            let old_abs = if crate::scanner::walk::is_absolute(old) {
                std::path::PathBuf::from(old)
            } else {
                thumb_dir.join(old)
            };
            if old_abs.exists() {
                let ext = old_abs
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let new_name = format!("{gid}{ext}");
                let new_abs = thumb_dir.join(&new_name);
                let _ = std::fs::rename(&old_abs, &new_abs);
                let _ = conn.execute(
                    "UPDATE library_item SET custom_cover_path = ?, thumbnail_path = ? WHERE id = ?",
                    rusqlite::params![new_name, new_name, item.item_id],
                );
            }
        }
    }

    let file_size = std::fs::metadata(&outcome.new_path).map(|m| m.len() as i64).unwrap_or(0);
    let file_mtime = std::fs::metadata(&outcome.new_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    let page_count = crate::download::page_count::count_pages(
        std::path::Path::new(&outcome.new_path),
        Some("cbz"),
    );

    conn.execute(
        "UPDATE library_item SET file_path = ?, format = 'cbz', page_count = ?, file_size = ?,
           file_mtime = ? WHERE id = ?",
        rusqlite::params![new_rel, page_count, file_size, file_mtime, item.item_id],
    )
    .map_err(|e| e.to_string())?;

    mark_completed(conn, outcome.queue_id, clock.now_ms() / 1000)?;

    Ok(json!({
        "itemId": item.item_id,
        "success": true,
        "newPath": outcome.new_path,
        "fileSize": file_size,
        "fileMtime": file_mtime,
        "lossless": outcome.lossless,
        "originalKept": outcome.original_kept,
        "originalPath": outcome.original_path,
        "forcedKeep": outcome.forced_keep,
    }))
}

/// The batch pump (library.ipc.ts:3000-3387): targets, enqueue/claim,
/// completion, cancel, lock-set-free Phase A shape.
#[allow(clippy::too_many_arguments)]
pub fn run_conversion_batch(
    conn: &mut Connection,
    ids: &[i64],
    resume: bool,
    options: &worker_cbz::ConvertOptions<'_>,
    cancel: &dyn Fn() -> bool,
    clock: &dyn Clock,
    log: &mut dyn FnMut(String),
) -> Result<Value, String> {
    // Targets: only rows with format === 'pdf' (:3000-3009).
    let mut targets: Vec<i64> = Vec::new();
    for id in ids {
        let is_pdf: Option<String> = conn
            .query_row("SELECT format FROM library_item WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        if is_pdf.as_deref() == Some("pdf") {
            targets.push(*id);
        }
    }
    let skipped = ids.len() - targets.len();

    // Fresh batch → clearFinished then enqueue; resume skips enqueue entirely
    // (:3011-3033) — the queue is the work list.
    if !resume {
        clear_finished(conn)?;
        for id in &targets {
            let file_path: Option<String> = conn
                .query_row("SELECT file_path FROM library_item WHERE id = ?", [id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            if let Some(fp) = file_path {
                conn.execute(
                    "INSERT INTO conversion_queue (file_path, library_item_id, keep_original, status)
                     VALUES (?, ?, ?, 'pending')
                     ON CONFLICT(file_path) DO UPDATE SET
                       status = 'pending', error_message = NULL,
                       library_item_id = excluded.library_item_id,
                       keep_original = excluded.keep_original",
                    rusqlite::params![fp, id, options.keep_original],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let batch_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversion_queue WHERE status = 'pending'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut converted = 0i64;
    let mut failed = 0i64;
    let mut cancelled = false;
    let mut errors: Vec<String> = Vec::new();

    loop {
        if cancel() {
            cancelled = true;
            break;
        }
        let Some((queue_id, file_path)) = claim_next(conn)? else {
            break;
        };
        // Stale row: item missing or no longer pdf → completed, move on
        // (:3117-3127) — not an error.
        let Some(mut item) = fetch_item(conn, &file_path)? else {
            mark_completed(conn, queue_id, clock.now_ms() / 1000)?;
            continue;
        };
        item.queue_id = Some(queue_id);
        // The worker command carries the RESOLVED absolute path
        // (library.ipc.ts:3151: resolveLibraryPath(item.filePath, root)).
        item.file_path = crate::download::resolve_library_path(&file_path, options.library_root)
            .to_string_lossy()
            .to_string();
        let format: Option<String> = conn
            .query_row("SELECT format FROM library_item WHERE id = ?", [item.item_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        if format.as_deref() != Some("pdf") {
            mark_completed(conn, queue_id, clock.now_ms() / 1000)?;
            continue;
        }

        match convert_one(conn, &item, options, clock, log) {
            Ok(_) => converted += 1,
            Err(e) => {
                mark_failed(conn, queue_id, &e)?;
                errors.push(format!("{}: {e}", item.file_path));
                failed += 1;
            }
        }
    }

    // After the batch: originals info invalidated (§2 step 7) — the cache
    // lives with the IPC layer; nothing to do headless.
    Ok(json!({
        "converted": converted,
        "failed": failed,
        "skipped": skipped,
        "batchTotal": batch_total,
        "cancelled": cancelled,
        "errors": errors,
    }))
}
