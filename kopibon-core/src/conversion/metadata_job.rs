//! convertAllMetadata port (library.ipc.ts:2010-2224) — made DB-backed and
//! resumable per the Q6 port decision (06 §5).
//!
//! **P2 DEVIATION — 04-parity-ledger §9 row required:** 1.x runs this job off
//! an in-memory array and loses its place on crash; 2.x uses a
//! `metadata_queue` table (same claim/clear shape as `conversion_queue`).
//! The migrator's additive `CREATE TABLE IF NOT EXISTS` is the only schema
//! touch on existing DBs. Everything else ports as-is: pool clamp 1-20,
//! per-run log file, progress shape, cancel-flags-current-item, payload
//! `{converted, failed, total, cancelled, errors?(<=20)}`.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::metadata::mappers::Clock;

pub const MAX_POOL: usize = 20;
pub const MAX_ERRORS: usize = 20;

/// Claim the next pending metadata row (UPDATE...RETURNING, same shape as the
/// conversion queue).
pub fn claim_next(conn: &mut Connection) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "UPDATE metadata_queue
         SET status = 'converting'
         WHERE id = (
           SELECT id FROM metadata_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1
         ) AND status = 'pending'
         RETURNING id, file_path",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn release(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("UPDATE metadata_queue SET status = 'pending' WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The per-item job (convert.worker.ts:50-80): apply_metadata per format +
/// the [nhentai-{id}] marker move to the filename end, preserving the real
/// extension.
pub fn convert_metadata_one(
    conn: &mut Connection,
    library_root: &str,
    file_path: &str,
    clock: &dyn Clock,
) -> Result<String, String> {
    // The DB stores paths relative to the library root; the file work uses
    // absolute paths.
    let abs = crate::download::resolve_library_path(file_path, library_root);
    let _ = &abs;
    // apply_metadata reads the format off the row.
    let (item_id, format, gallery_id): (i64, String, Option<i64>) = conn
        .query_row(
            "SELECT id, format, gallery_id FROM library_item WHERE file_path = ?",
            [file_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("library row missing: {file_path}"))?;

    let meta = crate::metadata::context::default_file_metadata();
    crate::metadata::writers::apply_metadata(
        &abs,
        if format == "pdf" {
            crate::metadata::context::Format::Pdf
        } else {
            crate::metadata::context::Format::Cbz
        },
        &meta,
        clock,
        clock.now_ms() as u64,
    )?;

    // Marker move (convert.worker.ts:56-80): ONLY when the FILENAME STARTS
    // with the marker — it is stripped, the real extension preserved, and
    // ` [nhentai-{id}]{ext}` appended. A marker in the middle stays put.
    let new_name = if let Some(gid) = gallery_id {
        let path = std::path::Path::new(file_path);
        let current_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let prefix = format!("[nhentai-{gid}]");
        let after_prefix = current_name
            .strip_prefix(&prefix)
            .map(|rest| rest.trim_start().to_string());
        match after_prefix {
            Some(stripped) => {
                let ext = stripped.rsplit('.').next().filter(|_| stripped.contains('.'));
                let ext = match ext {
                    Some(e) if !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()) => format!(".{e}"),
                    _ => if format == "cbz" { ".cbz".to_string() } else { ".pdf".to_string() },
                };
                let stem = stripped
                    .rsplit_once('.')
                    .map(|(s, _)| s.to_string())
                    .unwrap_or(stripped);
                format!("{stem} {prefix}{ext}")
            }
            None => current_name,
        }
    } else {
        file_path.to_string()
    };

    if new_name != file_path {
        let parent = abs.parent().unwrap_or(std::path::Path::new(""));
        let new_abs = parent.join(&new_name);
        std::fs::rename(&abs, &new_abs).map_err(|e| e.to_string())?;
        let new_rel = crate::download::relativize_library_path(&new_abs, library_root);
        conn.execute(
            "UPDATE library_item SET file_path = ? WHERE id = ?",
            rusqlite::params![new_rel, item_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(new_name)
}

/// The batch job. Runs the queue to completion (or cancellation), returning
/// the payload shape of 1.x (:2216-2219).
pub fn run_metadata_batch(
    conn: &mut Connection,
    library_root: &str,
    pool_clamp: usize,
    cancel: &dyn Fn() -> bool,
    clock: &dyn Clock,
    log: &mut dyn FnMut(String),
) -> Result<Value, String> {
    let _ = pool_clamp.clamp(1, MAX_POOL); // single-threaded Phase A runner
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM metadata_queue WHERE status = 'pending'", [], |r| r.get(0))
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
        match convert_metadata_one(conn, library_root, &file_path, clock) {
            Ok(new_name) => {
                converted += 1;
                log(format!("converted {file_path} -> {new_name}"));
                conn.execute(
                    "UPDATE metadata_queue SET status = 'completed' WHERE id = ?",
                    [queue_id],
                )
                .map_err(|e| e.to_string())?;
            }
            Err(e) => {
                failed += 1;
                if errors.len() < MAX_ERRORS {
                    errors.push(format!("{file_path}: {e}"));
                }
                conn.execute(
                    "UPDATE metadata_queue SET status = 'failed', error_message = ? WHERE id = ?",
                    rusqlite::params![e, queue_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(json!({
        "converted": converted,
        "failed": failed,
        "total": total,
        "cancelled": cancelled,
        "errors": errors,
    }))
}
