//! Blocked-values repo (blocked.repo.ts:30-110).
//!
//! Rows ordered by `(type, value)`; `entries()` drops rows with
//! unrecognised type/mode (a stale value would otherwise become a
//! malformed query term that fails silently); `add` upserts on
//! `(type, value COLLATE NOCASE)` so re-adding with a different mode is an
//! update, and counts as stored.

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::nhentai::query::{BlockedEntry, BLOCKED_TYPES};

const VALID_MODES: [&str; 2] = ["exclude", "dim"];

fn is_valid_mode(mode: &str) -> bool {
    VALID_MODES.contains(&mode)
}

fn row_to_value(id: i64, type_: String, value: String, mode: String, created_at: i64) -> Value {
    json!({
        "id": id,
        "type": type_,
        "value": value,
        "mode": mode,
        "createdAt": created_at,
    })
}

/// `blockedRepo.list` (blocked.repo.ts:31-38).
pub fn list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, type, value, mode, created_at FROM blocked_value ORDER BY type ASC, value ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, type_, value, mode, created_at) = row.map_err(|e| e.to_string())?;
        out.push(row_to_value(id, type_, value, mode, created_at));
    }
    Ok(out)
}

/// `blockedRepo.entries` (:47-55): rows as the query builder wants them.
pub fn entries(conn: &Connection) -> Result<Vec<BlockedEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT type, value, mode FROM blocked_value ORDER BY type ASC, value ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (type_, value, mode) = row.map_err(|e| e.to_string())?;
        if BLOCKED_TYPES.contains(&type_.as_str()) && is_valid_mode(&mode) {
            out.push(BlockedEntry { type_, value, mode });
        }
    }
    Ok(out)
}

/// `blockedRepo.add` (:64-84): upsert on `(type, value NOCASE)`; returns
/// the stored row, or `None` when rejected (blank/invalid).
pub fn add(conn: &Connection, type_: &str, value: &str, mode: &str) -> Result<Option<Value>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !BLOCKED_TYPES.contains(&type_) || !is_valid_mode(mode) {
        return Ok(None);
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO blocked_value (type, value, mode, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (type, value COLLATE NOCASE) DO UPDATE SET mode = excluded.mode",
        rusqlite::params![type_, trimmed, mode, now_ms],
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, type, value, mode, created_at FROM blocked_value WHERE type = ? AND value = ? COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![type_, trimmed])
        .map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row_to_value(
            row.get(0).map_err(|e| e.to_string())?,
            row.get(1).map_err(|e| e.to_string())?,
            row.get(2).map_err(|e| e.to_string())?,
            row.get(3).map_err(|e| e.to_string())?,
            row.get(4).map_err(|e| e.to_string())?,
        ))),
        None => Ok(None),
    }
}

/// `blockedRepo.addMany` (:87-93).
pub fn add_many(conn: &Connection, entries: &[BlockedEntry]) -> Result<i64, String> {
    let mut added = 0i64;
    for entry in entries {
        if add(conn, &entry.type_, &entry.value, &entry.mode)?.is_some() {
            added += 1;
        }
    }
    Ok(added)
}

/// `blockedRepo.setMode` (:95-99): invalid modes are ignored silently.
pub fn set_mode(conn: &Connection, id: i64, mode: &str) -> Result<(), String> {
    if !is_valid_mode(mode) {
        return Ok(());
    }
    conn.execute("UPDATE blocked_value SET mode = ? WHERE id = ?", rusqlite::params![mode, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `blockedRepo.remove` (:101-104).
pub fn remove(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM blocked_value WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
