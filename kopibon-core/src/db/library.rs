//! library.repo.ts port — the read methods the Phase A gate needs
//! (findPaginated, findAllIds, the autocompletes). Rows are returned as
//! column-name → JSON value maps so the differential harness can compare
//! row-for-row against better-sqlite3 regardless of column order.

use super::connection::Db;
use super::search::{build_library_filter, LibraryFilterParams};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Map, Value};

fn row_to_json(cols: &[String], row: &rusqlite::Row<'_>) -> Result<Value, String> {
    let mut map = Map::new();
    for (i, name) in cols.iter().enumerate() {
        let v: rusqlite::types::Value = row.get(i).map_err(|e| format!("col {name}: {e}"))?;
        map.insert(
            name.clone(),
            match v {
                SqlValue::Null => Value::Null,
                SqlValue::Integer(i) => Value::from(i),
                SqlValue::Real(f) => Value::from(f),
                SqlValue::Text(t) => Value::from(t),
                SqlValue::Blob(_) => Value::Null,
            },
        );
    }
    Ok(Value::Object(map))
}

fn order_by(sort_field: Option<&str>) -> &'static str {
    match sort_field {
        Some("title") => "custom_title COLLATE NOCASE ASC",
        Some("artist") => "primary_artist COLLATE NOCASE ASC",
        // 'added' and the default (library.repo.ts:406-416)
        _ => "added_at DESC",
    }
}

/// findPaginated (library.repo.ts:392-431): { items, total }.
pub fn find_paginated(
    db: &Db,
    params: &LibraryFilterParams,
    offset: usize,
    limit: usize,
    sort_field: Option<&str>,
) -> Result<(Vec<Value>, i64), String> {
    db.with_reader(|conn| {
        let filter = build_library_filter(params);
        let (where_sql, bind): (String, Vec<SqlValue>) = match &filter {
            Some(f) => (format!("WHERE {}", f.sql), f.params.clone()),
            None => (String::new(), Vec::new()),
        };

        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM library_item {where_sql}"),
                rusqlite::params_from_iter(bind.iter()),
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let sql = format!(
            "SELECT * FROM library_item {where_sql} ORDER BY {} LIMIT {} OFFSET {}",
            order_by(sort_field),
            limit,
            offset
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), |row| {
                row_to_json(&col_names, row)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok((items, total))
    })
}

/// findAllIds (library.repo.ts:451+): the select-all set — same filter as
/// findPaginated, so the grid and a batch action can never disagree.
pub fn find_all_ids(db: &Db, params: &LibraryFilterParams) -> Result<Vec<Value>, String> {
    db.with_reader(|conn| {
        let filter = build_library_filter(params);
        let (where_sql, bind): (String, Vec<SqlValue>) = match &filter {
            Some(f) => (format!("WHERE {}", f.sql), f.params.clone()),
            None => (String::new(), Vec::new()),
        };
        let sql = format!("SELECT id, format FROM library_item {where_sql} ORDER BY id ASC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), |row| {
                Ok(json!({"id": row.get::<_, i64>(0)?, "format": row.get::<_, String>(1)?}))
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

/// autocompleteArtists (library.repo.ts:833): LIKE (case-sensitive in JS? —
/// drizzle `like` → SQLite LIKE is case-insensitive for ASCII), grouped by
/// count, top 10.
pub fn autocomplete_artists(db: &Db, query: &str) -> Result<Vec<String>, String> {
    db.with_reader(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT artist_name, COUNT(*) AS count FROM library_item_artist
                 WHERE artist_name LIKE ? GROUP BY artist_name ORDER BY count DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([format!("%{query}%")], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

/// autocompleteSeries (library.repo.ts:849): distinct, non-empty, ordered.
pub fn autocomplete_series(db: &Db, query: &str) -> Result<Vec<String>, String> {
    db.with_reader(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT series_name FROM library_item
                 WHERE series_name LIKE ? AND series_name != '' AND series_name IS NOT NULL
                 ORDER BY series_name COLLATE NOCASE ASC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([format!("%{query}%")], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}
