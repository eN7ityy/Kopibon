//! sync.repo.ts port (03-data-model §6.4). 1.x stamped the claim/finish
//! path with `Date.now()` **ms**; the port writes `unixepoch()` seconds and
//! every comparison tolerates both units (03 §10.5) — never rewrite old rows.

use rusqlite::{Connection, OptionalExtension};

/// enqueue (sync.repo.ts:31-48): UPSERT on library_item_id, resetting.
pub fn enqueue(conn: &mut Connection, library_item_id: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_queue (library_item_id, status)
         VALUES (?, 'pending')
         ON CONFLICT(library_item_id) DO UPDATE SET
           status = 'pending',
           error_message = NULL,
           started_at = NULL,
           completed_at = NULL",
        [library_item_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// claimNext (sync.repo.ts:56-66): strictly serial — one row at a time.
pub fn claim_next(conn: &mut Connection) -> Result<Option<(i64, i64)>, String> {
    conn.query_row(
        "UPDATE sync_queue
         SET status = 'syncing', started_at = unixepoch()
         WHERE id = (
           SELECT id FROM sync_queue WHERE status = 'pending' ORDER BY id LIMIT 1
         ) AND status = 'pending'
         RETURNING id, library_item_id",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// finish (sync.repo.ts:68-76): status + completed_at; error when failed.
pub fn finish(conn: &mut Connection, id: i64, ok: bool, error: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_queue
         SET status = ?, error_message = ?, completed_at = unixepoch()
         WHERE id = ?",
        rusqlite::params![if ok { "completed" } else { "failed" }, error, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// requeueInterrupted (sync.repo.ts:107-114): 'syncing' → 'pending',
/// started_at NULL — feeds the resume banner.
pub fn requeue_interrupted(conn: &mut Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE sync_queue SET status = 'pending', started_at = NULL WHERE status = 'syncing'",
        [],
    )
    .map_err(|e| e.to_string())
}
