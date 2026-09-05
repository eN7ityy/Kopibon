//! scan_queue lifecycle (library-scanner.worker.ts:640-664, :744-749, :894-896,
//! :1082). Machine (03-data-model §6.2): pending → scanning → (row deleted on
//! complete) | failed. Single consumer — no RETURNING claim, do not "upgrade".

use rusqlite::Connection;

use super::walk::relative_path;

/// populateQueue (:640-648): one transaction, paths relative to the root.
pub fn populate_queue(conn: &Connection, root: &std::path::Path, file_paths: &[std::path::PathBuf]) -> Result<usize, String> {
    let mut inserted = 0;
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    for fp in file_paths {
        let rel = relative_path(root, fp);
        match conn.execute(
            "INSERT OR IGNORE INTO scan_queue (file_path, status) VALUES (?, 'pending')",
            [&rel],
        ) {
            Ok(n) => inserted += n,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.to_string());
            }
        }
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// requeueIncompleteItems (:658-664): 'scanning' + 'failed' → 'pending'.
pub fn requeue_incomplete_items(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE scan_queue SET status = 'pending' WHERE status IN ('scanning', 'failed')",
        [],
    )
    .map_err(|e| e.to_string())
}

/// Work query (:894-896): pending or scanning, priority DESC, id ASC.
pub fn pending_items(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT file_path FROM scan_queue
             WHERE status = 'pending' OR status = 'scanning'
             ORDER BY priority DESC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Claim = the single UPDATE (:940).
pub fn claim(conn: &Connection, file_path: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE scan_queue SET status = 'scanning' WHERE file_path = ?",
        [file_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// markQueueItem (:744-749). `now_ms` from the injected clock.
pub fn mark(
    conn: &Connection,
    root: &std::path::Path,
    absolute_path: &str,
    status: &str,
    now_ms: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let rel = relative_path(root, std::path::Path::new(absolute_path));
    conn.execute(
        "UPDATE scan_queue SET status = ?, scanned_at = ?, error_message = ? WHERE file_path = ?",
        rusqlite::params![status, now_ms, error, rel],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Final cleanup (:1082): completed rows deleted after the run.
pub fn cleanup_completed(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM scan_queue WHERE status = 'completed'", [])
        .map_err(|e| e.to_string())
}
