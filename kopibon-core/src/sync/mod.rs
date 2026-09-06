//! The batch sync pump — port of `library:syncBatch`
//! (library.ipc.ts:2460-2696) over the sync_queue machine (03-data-model
//! §6.4). Strictly serial: a crash strands exactly one 'syncing' row for
//! startup to requeue. Pacing derives from `endpointLimitPerMinute` at 90%
//! and the item's own work counts against the interval. Cancel is
//! cooperative — the in-flight item is never terminated mid-rewrite.

pub mod worker;
pub use worker::{SyncCommand, SyncFlatMetadata, SyncOutcome};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::metadata::mappers::Clock;
use crate::nhentai::http::Transport;
use crate::nhentai::limiter::{endpoint_limit_per_minute, EndpointKey};

/// enqueue (sync.repo.ts:31-48) over the ids of a fresh batch.
fn enqueue_ids(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    for id in ids {
        conn.execute(
            "INSERT INTO sync_queue (library_item_id, status)
             VALUES (?, 'pending')
             ON CONFLICT(library_item_id) DO UPDATE SET
               status = 'pending',
               error_message = NULL,
               started_at = NULL,
               completed_at = NULL",
            [id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// clearFinished (sync.repo.ts:125-128).
pub fn clear_finished(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM sync_queue WHERE status IN ('completed', 'failed')", [])
        .map_err(|e| e.to_string())
}

/// The pacing constants (library.ipc.ts:2577-2580): 90% of the endpoint
/// limit, interval = ceil(60000 / target). The sync derives its pacing from
/// the same table as the limiter — no hardcoded interval anywhere.
pub fn pacing_interval_ms(authenticated: bool) -> i64 {
    let limit = endpoint_limit_per_minute(EndpointKey::Gallery, authenticated) as i64;
    let target = (limit as f64 * 0.9).floor().max(1.0) as i64;
    (60_000.0 / target as f64).ceil() as i64
}

/// The batch pump. `ids` non-empty = fresh batch (clearFinished + enqueue);
/// empty = resume whatever is pending. Returns `{succeeded, failed, total}`
/// where total is the REQUESTED batch size (port as-is, :2687-2694).
#[allow(clippy::too_many_arguments)]
pub fn run_sync_batch<T: Transport>(
    conn: &mut Connection,
    transport: &T,
    ids: &[i64],
    api_key: Option<&str>,
    library_root: &str,
    cancel: &dyn Fn() -> bool,
    clock: &dyn Clock,
    jitter_ms: i64,
    sleep: &mut dyn FnMut(i64),
    notify: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    let requested = ids.len() as i64;
    if !ids.is_empty() {
        clear_finished(conn)?;
        enqueue_ids(conn, ids)?;
    }
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'syncing')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let authenticated = api_key.is_some();
    let interval_ms = pacing_interval_ms(authenticated);

    let mut succeeded = 0i64;
    let mut failed = 0i64;

    loop {
        // Cancel is cooperative: checked before the next claim (:2522-2526).
        if cancel() {
            break;
        }
        let Some((queue_id, library_item_id)) = crate::db::sync::claim_next(conn)? else {
            break;
        };
        let interval_start = clock.now_ms();

        // Per-item guards (:2603-2613).
        let row: Option<(String, Option<i64>, String)> = conn
            .query_row(
                "SELECT file_path, gallery_id, format FROM library_item WHERE id = ?",
                [library_item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((file_path, gallery_id, format)) = row else {
            crate::db::sync::finish(
                conn,
                queue_id,
                false,
                Some("No nhentai id, or the file is in use"),
            )?;
            failed += 1;
            continue;
        };
        let Some(nhentai_id) = gallery_id else {
            crate::db::sync::finish(
                conn,
                queue_id,
                false,
                Some("No nhentai id, or the file is in use"),
            )?;
            failed += 1;
            continue;
        };

        // Series from our own DB (:27-37).
        let (series_name, series_index): (Option<String>, Option<f64>) = conn
            .query_row(
                "SELECT series_name, series_index FROM library_item WHERE id = ?",
                [library_item_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, None));

        let abs_path = crate::download::resolve_library_path(&file_path, library_root)
            .to_string_lossy()
            .to_string();
        let cmd = SyncCommand {
            item_id: library_item_id,
            nhentai_id,
            file_path: &abs_path,
            format: &format,
            api_key,
            series_name: series_name.as_deref(),
            series_index,
        };
        let outcome = worker::sync_item(transport, &cmd, clock, jitter_ms, sleep);

        match outcome {
            SyncOutcome::Success {
                raw_tags,
                gallery,
                metadata,
            } => {
                // Main-side commit (:2312-2399) — best-effort.
                let commit = commit_sync_result(
                    conn,
                    library_root,
                    library_item_id,
                    &file_path,
                    &raw_tags,
                    &gallery,
                    &metadata,
                );
                if let Err(e) = commit {
                    eprintln!("sync commit failed (best-effort): {e}");
                }
                succeeded += 1;
            }
            SyncOutcome::Error { message } => {
                crate::db::sync::finish(conn, queue_id, false, Some(&message))?;
                failed += 1;
            }
        }

        // Progress after every item (:2631-2648).
        notify(json!({
            "current": succeeded + failed,
            "total": total,
        }));

        // The sleep counts the item's own work: only the REMAINING part of
        // the interval is slept (:2650-2659).
        let elapsed = clock.now_ms() - interval_start;
        let remaining = interval_ms - elapsed;
        if remaining > 0 {
            sleep(remaining);
        }
    }

    Ok(json!({
        "succeeded": succeeded,
        "failed": failed,
        "total": requested,
    }))
}

/// The main-side commit (:2312-2399): library row + gallery cache upsert.
/// A failure must not fail the sync result (:2397-2399).
#[allow(clippy::too_many_arguments)]
fn commit_sync_result(
    conn: &Connection,
    library_root: &str,
    item_id: i64,
    rel_file_path: &str,
    raw_tags: &Value,
    gallery: &Value,
    metadata: &SyncFlatMetadata,
) -> Result<(), String> {
    // Page count re-derived from the rewritten file (:2324-2328).
    let abs = crate::download::resolve_library_path(rel_file_path, library_root);
    let page_count = crate::download::page_count::count_pages(&abs, None);

    conn.execute(
        "UPDATE library_item SET custom_title = ?, custom_tags = ?, custom_language = ?,
           publisher = ?, language = ?, page_count = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![
            metadata.title,
            metadata.tags,
            metadata.language,
            metadata.publisher,
            metadata.language,
            page_count,
            crate::db::now_s(),
            item_id
        ],
    )
    .map_err(|e| e.to_string())?;

    // The cached gallery row enriched with EVERYTHING the response carried
    // (:2356-2394) — sync used to post tags only and 837 rows stayed poorer.
    if let Some(gid) = gallery["id"].as_i64() {
        let raw_json = serde_json::to_string(gallery).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO gallery (id, media_id, title_pretty, title_english, title_japanese,
               page_count, favorites_count, upload_date, thumbnail_url, cover_url,
               raw_tags_json, raw_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               media_id = excluded.media_id,
               title_pretty = excluded.title_pretty,
               title_english = excluded.title_english,
               title_japanese = excluded.title_japanese,
               page_count = excluded.page_count,
               favorites_count = excluded.favorites_count,
               upload_date = excluded.upload_date,
               thumbnail_url = excluded.thumbnail_url,
               cover_url = excluded.cover_url,
               raw_tags_json = excluded.raw_tags_json,
               raw_json = excluded.raw_json,
               updated_at = excluded.updated_at",
            rusqlite::params![
                gid,
                gallery["media_id"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0),
                gallery.pointer("/title/pretty").and_then(Value::as_str).unwrap_or(""),
                gallery.pointer("/title/english").and_then(Value::as_str).unwrap_or(""),
                gallery.pointer("/title/japanese").and_then(Value::as_str),
                gallery["num_pages"].as_i64().unwrap_or(0),
                gallery["num_favorites"].as_i64().unwrap_or(0),
                gallery["upload_date"].as_i64(),
                gallery
                    .pointer("/thumbnail/path")
                    .and_then(Value::as_str)
                    .map(|p| format!("https://t.nhentai.net/{p}")),
                gallery
                    .pointer("/cover/path")
                    .and_then(Value::as_str)
                    .map(|p| format!("https://t.nhentai.net/{p}")),
                serde_json::to_string(raw_tags).map_err(|e| e.to_string())?,
                raw_json,
                crate::db::now_s(),
                crate::db::now_s(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
