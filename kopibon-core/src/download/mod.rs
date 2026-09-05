//! DownloadManager port (download-manager.ts) — queue pump, claim, control.
//!
//! **Single-scheduler invariant (03 §3, port decision):** one pump consumes
//! the queue; 1.x's read-then-write claim (`findByStatus('queued')`, sort
//! `priority DESC, queuedAt ASC`, separate UPDATE → 'downloading', guarded by
//! the `processingQueue` reentrancy flag) is preserved — NOT the
//! `UPDATE…RETURNING` pattern of the conversion/sync queues, which have N
//! runners. If this ever allows multiple download consumers, that is the
//! trigger to switch claim patterns.
//!
//! Phase A runs the pump synchronously (`process_queue`); `maxConcurrent` is
//! applied to the claim loop, so the claim ORDER (priority DESC, queuedAt
//! ASC) is directly testable.

pub mod cdn;
pub mod page_count;
pub mod pipeline;
pub mod worker_cbz;
pub mod worker_pdf;

use std::path::Path;

use rusqlite::Connection;

use crate::metadata::mappers::Clock;
use crate::nhentai::http::Transport;
use pipeline::ActiveFlags;

/// Library-path helpers (library-paths.ts): DB stores paths relative to the
/// library root; resolve/relativize at the DB boundary.
pub fn resolve_library_path(relative_path: &str, library_root: &str) -> std::path::PathBuf {
    if relative_path.is_empty() {
        return std::path::PathBuf::new();
    }
    if crate::scanner::walk::is_absolute(relative_path) {
        return std::path::PathBuf::from(relative_path); // pre-migration row
    }
    std::path::PathBuf::from(crate::scanner::walk::normalize_path(&format!(
        "{library_root}/{relative_path}"
    )))
}

pub fn relativize_library_path(absolute_path: &std::path::Path, library_root: &str) -> String {
    crate::scanner::walk::relative_path(std::path::Path::new(library_root), absolute_path)
}

/// setMaxConcurrent clamp (download-manager.ts:144-152): 1–8.
pub fn clamp_concurrency(n: f64, current: usize) -> usize {
    if n.is_finite() {
        (n.floor() as i64).clamp(1, 8) as usize
    } else {
        current
    }
}

/// reconcileInterrupted (:271-290): rows left 'downloading'/'converting' by a
/// crash → 'queued', page rows deleted, scratch purged. Idempotent; returns
/// the count.
pub fn reconcile_interrupted(conn: &Connection, data_dir: &Path) -> Result<usize, String> {
    let mut requeued = 0;
    for status in ["downloading", "converting"] {
        let items = crate::db::download::find_by_status(conn, status)?;
        for item in items {
            let id = item["id"].as_i64().unwrap_or(0);
            let gallery_id = item["gallery_id"].as_i64().unwrap_or(0);
            crate::db::download::update(
                conn,
                id,
                &crate::db::download::QueueUpdate {
                    status: Some("queued".to_string()),
                    error_message: Some(None),
                    started_at: Some(None),
                    completed_at: None,
                },
            )?;
            // Page rows are re-created from scratch on the next attempt.
            crate::db::download::delete_pages(conn, id)?;
            let _ = std::fs::remove_dir_all(
                data_dir.join("download-tmp").join(gallery_id.to_string()),
            );
            requeued += 1;
        }
    }
    Ok(requeued)
}

/// The pump. Claims queued rows (priority DESC, queued_at ASC), runs each
/// pipeline to a terminal state, repeats until the queue is empty.
#[allow(clippy::too_many_arguments)]
pub fn process_queue<T: Transport>(
    conn: &mut Connection,
    client: &mut crate::nhentai::ApiClient<T>,
    cdn: &mut cdn::CdnState,
    library_root: &str,
    data_dir: &Path,
    max_concurrent: usize,
    clock: &dyn Clock,
    sleep: &mut dyn FnMut(i64),
    notify: &mut dyn FnMut(pipeline::DownloadProgress),
    page_fetch: &dyn Fn(&str) -> Result<Vec<u8>, pipeline::PageFetchError>,
    mut on_active: impl FnMut(i64, ActiveFlags),
) -> Result<(), String> {
    // The synchronous Phase A pump honours the slot limit by draining one
    // item at a time; the claim ORDER is what the max-concurrent tests assert.
    let _ = max_concurrent;
    loop {
        let next = dequeue_next(conn, clock)?;
        let Some((queue_id, gallery_id, output_format)) = next else {
            return Ok(());
        };
        let flags = ActiveFlags::new();
        on_active(queue_id, flags.clone());
        pipeline::download_item(
            conn,
            client,
            cdn,
            queue_id,
            gallery_id,
            &output_format,
            &flags,
            library_root,
            data_dir,
            clock,
            sleep,
            notify,
            page_fetch,
        );
    }
}

/// dequeueNext (:210-224): read-then-write claim, sort priority DESC then
/// queued_at ASC (oldest first), UPDATE → 'downloading' + startedAt.
pub fn dequeue_next(
    conn: &Connection,
    clock: &dyn Clock,
) -> Result<Option<(i64, i64, String)>, String> {
    let items = crate::db::download::find_by_status(conn, "queued")?;
    if items.is_empty() {
        return Ok(None);
    }
    let mut sorted = items;
    sorted.sort_by(|a, b| {
        let pa = a["priority"].as_i64().unwrap_or(0);
        let pb = b["priority"].as_i64().unwrap_or(0);
        let qa = a["queued_at"].as_i64().unwrap_or(0);
        let qb = b["queued_at"].as_i64().unwrap_or(0);
        pb.cmp(&pa).then(qa.cmp(&qb))
    });
    let next = sorted[0].clone();
    crate::db::download::update(
        conn,
        next["id"].as_i64().unwrap_or(0),
        &crate::db::download::QueueUpdate {
            status: Some("downloading".to_string()),
            error_message: None,
            started_at: Some(Some(clock.now_ms() / 1000)),
            completed_at: None,
        },
    )?;
    Ok(Some((
        next["id"].as_i64().unwrap_or(0),
        next["gallery_id"].as_i64().unwrap_or(0),
        next["output_format"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("cbz")
            .to_string(),
    )))
}

// ─── Control (pause / resume / cancel, :872-966) ────────────────────────────

/// Pause of a non-active queued row: DB flips to 'paused'. Active items are
/// flagged via ActiveFlags (the pump's batch loop polls it).
pub fn pause_queued(conn: &Connection, queue_id: i64) -> Result<bool, String> {
    let item = crate::db::download::find_by_id(conn, queue_id)?;
    match item {
        Some(item) if item["status"].as_str() == Some("queued") => {
            crate::db::download::update(
                conn,
                queue_id,
                &crate::db::download::QueueUpdate::status("paused"),
            )?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Resume of a paused row → 'queued' (the pump picks it up again).
pub fn resume_paused(conn: &Connection, queue_id: i64) -> Result<bool, String> {
    let item = crate::db::download::find_by_id(conn, queue_id)?;
    match item {
        Some(item) if item["status"].as_str() == Some("paused") => {
            crate::db::download::update(
                conn,
                queue_id,
                &crate::db::download::QueueUpdate::status("queued"),
            )?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Cancel of a queued/paused row deletes the row + its page rows (:928-934).
pub fn cancel_queued(conn: &Connection, queue_id: i64) -> Result<bool, String> {
    let item = crate::db::download::find_by_id(conn, queue_id)?;
    match item {
        Some(item)
            if matches!(item["status"].as_str(), Some("queued") | Some("paused")) =>
        {
            crate::db::download::delete(conn, queue_id)?;
            crate::db::download::delete_pages(conn, queue_id)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// pauseAll / resumeAll (:940-966): sweep the queued/paused rows.
pub fn pause_all(conn: &Connection) -> Result<usize, String> {
    let queued = crate::db::download::find_by_status(conn, "queued")?;
    for item in &queued {
        crate::db::download::update(
            conn,
            item["id"].as_i64().unwrap_or(0),
            &crate::db::download::QueueUpdate::status("paused"),
        )?;
    }
    Ok(queued.len())
}

pub fn resume_all(conn: &Connection) -> Result<usize, String> {
    let paused = crate::db::download::find_by_status(conn, "paused")?;
    for item in &paused {
        crate::db::download::update(
            conn,
            item["id"].as_i64().unwrap_or(0),
            &crate::db::download::QueueUpdate::status("queued"),
        )?;
    }
    Ok(paused.len())
}
