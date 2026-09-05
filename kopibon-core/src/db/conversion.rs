//! conversion.repo.ts port (raw handle; 03-data-model §6.3). The atomic
//! claim is the single-statement `UPDATE … WHERE id = (SELECT …) AND
//! status='pending' RETURNING` shape — the `AND` is redundant on purpose and
//! stays (05-DB §7).

use rusqlite::Connection;

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
