//! sync.repo.ts port (03-data-model §6.4). 1.x stamped the claim/finish
//! path with `Date.now()` **ms**; the port writes `unixepoch()` seconds and
//! every comparison tolerates both units (03 §10.5) — never rewrite old rows.

use rusqlite::{Connection, OptionalExtension};

/// counts (sync.repo.ts:78-87): `{ pending, syncing, completed, failed }`,
/// unknown statuses ignored.
pub fn counts(conn: &Connection) -> Result<serde_json::Value, String> {
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM sync_queue GROUP BY status")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = mapped.filter_map(|r| r.ok()).collect();
    let mut out = serde_json::json!({ "pending": 0, "syncing": 0, "completed": 0, "failed": 0 });
    for (status, n) in rows {
        if out.get(&status).is_some() {
            out[status] = serde_json::Value::from(n);
        }
    }
    Ok(out)
}

/// recentErrors (sync.repo.ts:90-99, default limit 5): first failures for
/// the resume banner.
pub fn recent_errors(conn: &Connection, limit: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT error_message FROM sync_queue
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

/// clearFinished (sync.repo.ts:117-122).
pub fn clear_finished_rows(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM sync_queue WHERE status IN ('completed', 'failed')",
        [],
    )
    .map_err(|e| e.to_string())
}

/// clear (sync.repo.ts:124+): forget the whole queue, pending included.
pub fn clear_all(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM sync_queue", [])
        .map_err(|e| e.to_string())
}

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

/// finish-by-item (sync.repo.ts:68-76 as the IPC layer calls it): the batch
/// loop passes the *library item* id, matched with
/// `WHERE library_item_id = ?` — `error = None` completes, `Some` fails.
pub fn finish_by_item(
    conn: &mut Connection,
    library_item_id: i64,
    error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_queue
         SET status = ?, error_message = ?, completed_at = unixepoch()
         WHERE library_item_id = ?",
        rusqlite::params![if error.is_some() { "failed" } else { "completed" }, error, library_item_id],
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
