//! conversion.repo.ts port (raw handle; 03-data-model §6.3). The atomic
//! claim is the single-statement `UPDATE … WHERE id = (SELECT …) AND
//! status='pending' RETURNING` shape — the `AND` is redundant on purpose and
//! stays (05-DB §7).

use rusqlite::Connection;

/// counts (conversion.repo.ts:115-124): `{ pending, converting, completed,
/// failed }`, unknown statuses ignored (`if (r.status in out)`).
pub fn counts(conn: &Connection) -> Result<serde_json::Value, String> {
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM conversion_queue GROUP BY status")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = mapped.filter_map(|r| r.ok()).collect();
    let mut out = serde_json::json!({ "pending": 0, "converting": 0, "completed": 0, "failed": 0 });
    for (status, n) in rows {
        if out.get(&status).is_some() {
            out[status] = serde_json::Value::from(n);
        }
    }
    Ok(out)
}

/// pendingItemIds (conversion.repo.ts:127-135): library ids still awaiting
/// conversion, for the UI locks.
pub fn pending_item_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT library_item_id FROM conversion_queue
             WHERE status IN ('pending','converting') AND library_item_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<i64>, _>>()
        .map_err(|e| e.to_string())
}

/// recentErrors (conversion.repo.ts:138-146, default limit 20).
pub fn recent_errors(conn: &Connection, limit: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT error_message FROM conversion_queue
             WHERE status = 'failed' AND error_message IS NOT NULL
             ORDER BY completed_at DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([limit], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

/// clearFinished (conversion.repo.ts:152-156): drop finished rows so a new
/// batch's queue reflects outstanding work.
pub fn clear_finished_rows(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM conversion_queue WHERE status IN ('completed','failed')",
        [],
    )
    .map_err(|e| e.to_string())
}

/// enqueue (conversion.repo.ts:40-61): UPSERT on file_path, resetting to
/// pending, clearing error/timestamps, refreshing library_item_id and the
/// per-row keep_original.
pub fn enqueue(
    conn: &mut Connection,
    file_path: &str,
    library_item_id: Option<i64>,
    keep_original: bool,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO conversion_queue (file_path, status, library_item_id, keep_original)
         VALUES (?, 'pending', ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           status = 'pending',
           error_message = NULL,
           started_at = NULL,
           completed_at = NULL,
           library_item_id = excluded.library_item_id,
           keep_original = excluded.keep_original",
        rusqlite::params![file_path, library_item_id, keep_original as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// claimNext (conversion.repo.ts:69-88): exactly one row per runner.
pub fn claim_next(conn: &mut Connection) -> Result<Option<(i64, String)>, String> {
    let rows = conn
        .query_row(
            "UPDATE conversion_queue
             SET status = 'converting', started_at = unixepoch()
             WHERE id = (
               SELECT id FROM conversion_queue
               WHERE status = 'pending'
               ORDER BY priority DESC, id ASC
               LIMIT 1
             ) AND status = 'pending'
             RETURNING id, file_path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

use rusqlite::OptionalExtension;

/// markFailed (conversion.repo.ts:98-104): error truncated to 2000 chars.
pub fn mark_failed(conn: &mut Connection, id: i64, error: &str) -> Result<(), String> {
    let truncated: String = error.chars().take(2000).collect();
    conn.execute(
        "UPDATE conversion_queue
         SET status = 'failed', error_message = ?, completed_at = unixepoch()
         WHERE id = ?",
        rusqlite::params![truncated, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// release (conversion.repo.ts:107-113).
pub fn release(conn: &mut Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE conversion_queue
         SET status = 'pending', started_at = NULL
         WHERE id = ?",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
