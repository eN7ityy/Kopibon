//! download.repo.ts port — queue + per-attempt page bookkeeping.
//! Timestamps: 1.x wrote `Date.now()` ms on startedAt/completedAt; the port
//! writes `unixepoch()` seconds (03-data-model §10.5, tolerate ms on read).

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

fn row_json(cols: &[&str], row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut o = serde_json::Map::new();
    for (i, c) in cols.iter().enumerate() {
        let v: rusqlite::types::Value = row.get(i)?;
        o.insert(
            (*c).to_string(),
            match v {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(i) => json!(i),
                rusqlite::types::Value::Real(f) => json!(f),
                rusqlite::types::Value::Text(t) => json!(t),
                rusqlite::types::Value::Blob(_) => Value::Null,
            },
        );
    }
    Ok(Value::Object(o))
}

const QUEUE_COLS: &str = "id, gallery_id, status, priority, retry_count, max_retries, error_message, output_format, output_directory, queued_at, started_at, completed_at";
const QUEUE_COLS_ARRAY: [&str; 12] = [
    "id",
    "gallery_id",
    "status",
    "priority",
    "retry_count",
    "max_retries",
    "error_message",
    "output_format",
    "output_directory",
    "queued_at",
    "started_at",
    "completed_at",
];

fn queue_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    row_json(&QUEUE_COLS_ARRAY, row)
}

pub fn find_all(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {QUEUE_COLS} FROM download_queue"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], queue_row)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn find_by_id(conn: &Connection, id: i64) -> Result<Option<Value>, String> {
    conn.query_row(
        &format!("SELECT {QUEUE_COLS} FROM download_queue WHERE id = ?"),
        [id],
        queue_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn find_by_status(conn: &Connection, status: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {QUEUE_COLS} FROM download_queue WHERE status = ?"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([status], queue_row)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn find_by_gallery_id(conn: &Connection, gallery_id: i64) -> Result<Option<Value>, String> {
    conn.query_row(
        &format!("SELECT {QUEUE_COLS} FROM download_queue WHERE gallery_id = ?"),
        [gallery_id],
        queue_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// findActiveByGalleryId (download.repo.ts:44-52): deliberately excludes
/// 'completed'/'failed' so a retry is never blocked by history.
pub fn find_active_by_gallery_id(conn: &Connection, gallery_id: i64) -> Result<Option<Value>, String> {
    conn.query_row(
        &format!(
            "SELECT {QUEUE_COLS} FROM download_queue
             WHERE gallery_id = ? AND status IN ('queued', 'paused', 'downloading', 'converting')"
        ),
        [gallery_id],
        queue_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// insert (download.repo.ts). `started_at_s`/`completed_at_s` are seconds
/// (port rule) — pass None for the usual defaults.
pub fn insert(
    conn: &Connection,
    gallery_id: i64,
    output_format: &str,
    priority: Option<i64>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO download_queue (gallery_id, output_format, priority) VALUES (?, ?, ?)",
        rusqlite::params![gallery_id, output_format, priority.unwrap_or(0)],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// update (download.repo.ts:69-89): partial update over the mutable columns.
pub struct QueueUpdate {
    pub status: Option<String>,
    pub error_message: Option<Option<String>>,
    pub started_at: Option<Option<i64>>,
    pub completed_at: Option<Option<i64>>,
}

impl QueueUpdate {
    pub fn status(status: &str) -> Self {
        QueueUpdate {
            status: Some(status.to_string()),
            error_message: None,
            started_at: None,
            completed_at: None,
        }
    }
}

pub fn update(conn: &Connection, id: i64, up: &QueueUpdate) -> Result<(), String> {
    let mut sets: Vec<String> = Vec::new();
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(status) = &up.status {
        sets.push("status = ?".to_string());
        bind.push(rusqlite::types::Value::Text(status.clone()));
    }
    if let Some(err) = &up.error_message {
        sets.push("error_message = ?".to_string());
        bind.push(match err {
            Some(e) => rusqlite::types::Value::Text(e.clone()),
            None => rusqlite::types::Value::Null,
        });
    }
    if let Some(t) = &up.started_at {
        sets.push("started_at = ?".to_string());
        bind.push(match t {
            Some(v) => rusqlite::types::Value::Integer(*v),
            None => rusqlite::types::Value::Null,
        });
    }
    if let Some(t) = &up.completed_at {
        sets.push("completed_at = ?".to_string());
        bind.push(match t {
            Some(v) => rusqlite::types::Value::Integer(*v),
            None => rusqlite::types::Value::Null,
        });
    }
    if sets.is_empty() {
        return Ok(());
    }
    bind.push(rusqlite::types::Value::Integer(id));
    conn.execute(
        &format!(
            "UPDATE download_queue SET {} WHERE id = ?",
            sets.join(", ")
        ),
        rusqlite::params_from_iter(bind.iter()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM download_queue WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Pages ──────────────────────────────────────────────────────────────────

const PAGE_COLS: &str = "id, queue_id, page_number, url, status, local_path, file_size, retry_count";
const PAGE_COLS_ARRAY: [&str; 8] = [
    "id",
    "queue_id",
    "page_number",
    "url",
    "status",
    "local_path",
    "file_size",
    "retry_count",
];

fn page_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    row_json(&PAGE_COLS_ARRAY, row)
}

pub fn insert_page(conn: &Connection, queue_id: i64, page_number: i64) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO download_page (queue_id, page_number, url, status, retry_count) VALUES (?, ?, '', 'pending', 0)",
        rusqlite::params![queue_id, page_number],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn get_pages(conn: &Connection, queue_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PAGE_COLS} FROM download_page WHERE queue_id = ? ORDER BY page_number ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([queue_id], page_row)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn update_page(
    conn: &Connection,
    page_id: i64,
    status: &str,
    retry_count: i64,
    local_path: Option<&str>,
    file_size: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE download_page SET status = ?, retry_count = ?, local_path = ?, file_size = ? WHERE id = ?",
        rusqlite::params![status, retry_count, local_path, file_size, page_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_pages(conn: &Connection, queue_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM download_page WHERE queue_id = ?", [queue_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
