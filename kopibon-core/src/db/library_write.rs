//! IPC row helpers for `library_item` (library.repo.ts read/write surface).
//!
//! The subsystems write their own rows with inline SQL; the `library:*`
//! commands need the generic surface (find/update/delete/insert, artists,
//! scan log, series row tweaks). Rows come back camelCase, the drizzle
//! shape the renderer already speaks.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

/// `SELECT` list with the camelCase aliases every reader below shares.
const SELECT_CAMEL: &str = "SELECT id, gallery_id AS galleryId, is_custom AS isCustom,
    custom_title AS customTitle, custom_tags AS customTags,
    custom_language AS customLanguage, custom_date AS customDate,
    custom_cover_path AS customCoverPath, file_path AS filePath,
    file_size AS fileSize, format, primary_artist AS primaryArtist,
    series_name AS seriesName, series_index AS seriesIndex,
    series_id AS seriesId, language, publisher, description,
    page_count AS pageCount, read_progress AS readProgress,
    file_mtime AS fileMtime, thumbnail_path AS thumbnailPath,
    added_at AS addedAt, updated_at AS updatedAt
    FROM library_item";

fn row_value(cols: &[String], row: &rusqlite::Row<'_>) -> Result<Value, String> {
    let mut map = Map::new();
    for (i, name) in cols.iter().enumerate() {
        let v: rusqlite::types::Value = row.get(i).map_err(|e| format!("col {name}: {e}"))?;
        map.insert(
            name.clone(),
            match v {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(i) => Value::from(i),
                rusqlite::types::Value::Real(f) => Value::from(f),
                rusqlite::types::Value::Text(t) => Value::from(t),
                rusqlite::types::Value::Blob(_) => Value::Null,
            },
        );
    }
    Ok(Value::Object(map))
}

fn query_row_value(
    stmt: &mut rusqlite::Statement<'_>,
    params: impl rusqlite::Params,
) -> Result<Option<Value>, String> {
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    stmt.query_row(params, |row| row_value(&cols, row).map_err(|_| rusqlite::Error::InvalidQuery))
        .optional()
        .map_err(|e| e.to_string())
}

fn query_all_values(
    stmt: &mut rusqlite::Statement<'_>,
    params: impl rusqlite::Params,
) -> Result<Vec<Value>, String> {
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mapped = stmt
        .query_map(params, |row| {
            row_value(&cols, row).map_err(|_| rusqlite::Error::InvalidQuery)
        })
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// findById (library.repo.ts:398-400).
pub fn find_item_by_id(conn: &Connection, id: i64) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_CAMEL} WHERE id = ?"))
        .map_err(|e| e.to_string())?;
    query_row_value(&mut stmt, [id])
}

/// findAll (library.repo.ts:297-301): newest first.
pub fn find_all_items(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_CAMEL} ORDER BY added_at DESC"))
        .map_err(|e| e.to_string())?;
    query_all_values(&mut stmt, [])
}

/// findByGalleryId (library.repo.ts:625-627): `gallery_id` is unique.
pub fn find_item_by_gallery_id(
    conn: &Connection,
    gallery_id: i64,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_CAMEL} WHERE gallery_id = ?"))
        .map_err(|e| e.to_string())?;
    query_row_value(&mut stmt, [gallery_id])
}

/// findByFilePath (library.repo.ts:629-631).
pub fn find_item_by_file_path(
    conn: &Connection,
    file_path: &str,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_CAMEL} WHERE file_path = ?"))
        .map_err(|e| e.to_string())?;
    query_row_value(&mut stmt, [file_path])
}

/// searchByTitle (library.repo.ts:780-787): substring over the pretty,
/// raw and file titles.
pub fn search_items_by_title(conn: &Connection, query: &str) -> Result<Vec<Value>, String> {
    let like = format!("%{query}%");
    let mut stmt = conn
        .prepare(&format!(
            "{SELECT_CAMEL} WHERE custom_title LIKE ? OR file_path LIKE ? OR primary_artist LIKE ?"
        ))
        .map_err(|e| e.to_string())?;
    query_all_values(&mut stmt, [&like, &like, &like])
}

/// getArtists (library.repo.ts:772-779): `{ id, libraryItemId, artistName,
/// sortOrder }` rows in sort order.
pub fn item_artists(conn: &Connection, library_item_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, library_item_id AS libraryItemId, artist_name AS artistName,
                    sort_order AS sortOrder
             FROM library_item_artist WHERE library_item_id = ? ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    query_all_values(&mut stmt, [library_item_id])
}

/// getAllArtistNames (library.repo.ts:794-801): distinct artist names.
pub fn all_artist_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT artist_name FROM library_item_artist")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

/// getAllSeriesNames (library.repo.ts:803-810): distinct non-null series.
pub fn all_series_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT series_name FROM library_item WHERE series_name IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

/// getAllTagNames (library.repo.ts:812-819): distinct non-null tag strings.
pub fn all_tag_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT custom_tags FROM library_item WHERE custom_tags IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    mapped
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

/// getLastScanLog (library.repo.ts:889-895).
pub fn last_scan_log(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM library_scan_log ORDER BY id DESC LIMIT 1")
        .map_err(|e| e.to_string())?;
    query_row_value(&mut stmt, [])
}

// ─── Writes ────────────────────────────────────────────────────────────

/// A typed update value (drizzle `.set()` shape, camelCase keys in).
#[derive(Debug, Clone)]
pub enum FieldValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

impl FieldValue {
    pub fn from_json(v: &Value) -> Self {
        match v {
            Value::Null => FieldValue::Null,
            Value::Bool(b) => FieldValue::Int(i64::from(*b)),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    FieldValue::Int(i)
                } else if let Some(f) = n.as_f64() {
                    FieldValue::Real(f)
                } else {
                    FieldValue::Null
                }
            }
            Value::String(s) => FieldValue::Text(s.clone()),
            _ => FieldValue::Null,
        }
    }

    fn bind<'a>(&self, col: &'a str) -> (&'a str, rusqlite::types::Value) {
        match self {
            FieldValue::Null => (col, rusqlite::types::Value::Null),
            FieldValue::Int(i) => (col, rusqlite::types::Value::Integer(*i)),
            FieldValue::Real(f) => (col, rusqlite::types::Value::Real(*f)),
            FieldValue::Text(s) => (
                col,
                rusqlite::types::Value::Text(s.clone()),
            ),
        }
    }
}

/// camelCase key → real column. Keys outside this table are SKIPPED, not
/// rejected: drizzle's `buildUpdateSet` iterates table columns and never
/// reads unknown keys, so `synced`/`syncedAt` (which exist on no table the
/// sync-complete update touches) are silently dropped in 1.x too.
fn update_column(key: &str) -> Option<&'static str> {
    Some(match key {
        "galleryId" => "gallery_id",
        "isCustom" => "is_custom",
        "customTitle" => "custom_title",
        "customTags" => "custom_tags",
        "customLanguage" => "custom_language",
        "customDate" => "custom_date",
        "customCoverPath" => "custom_cover_path",
        "filePath" => "file_path",
        "fileSize" => "file_size",
        "format" => "format",
        "primaryArtist" => "primary_artist",
        "seriesName" => "series_name",
        "seriesIndex" => "series_index",
        "seriesId" => "series_id",
        "language" => "language",
        "publisher" => "publisher",
        "description" => "description",
        "pageCount" => "page_count",
        "readProgress" => "read_progress",
        "fileMtime" => "file_mtime",
        "thumbnailPath" => "thumbnail_path",
        "updatedAt" => "updated_at",
        _ => return None,
    })
}

/// Generic row update (library.repo.ts `update`): `SET` the known columns,
/// skip the rest. Returns rows changed.
pub fn update_item_fields(
    conn: &Connection,
    id: i64,
    fields: &[(String, FieldValue)],
) -> Result<usize, String> {
    let bound: Vec<(&str, rusqlite::types::Value)> = fields
        .iter()
        .filter_map(|(k, v)| update_column(k).map(|col| v.bind(col)))
        .collect();
    if bound.is_empty() {
        return Ok(0);
    }
    let set_sql = bound
        .iter()
        .map(|(col, _)| format!("{col} = ?"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!("UPDATE library_item SET {set_sql} WHERE id = ?"))
        .map_err(|e| e.to_string())?;
    let mut params: Vec<rusqlite::types::Value> =
        bound.into_iter().map(|(_, v)| v).collect();
    params.push(rusqlite::types::Value::Integer(id));
    stmt.execute(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| e.to_string())
}

/// delete (library.repo.ts:376-380): artists first, then the row.
pub fn delete_item(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM library_item_artist WHERE library_item_id = ?",
        [id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM library_item WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// addArtist (library.repo.ts:782-785).
pub fn add_artist(
    conn: &Connection,
    library_item_id: i64,
    artist_name: &str,
    sort_order: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO library_item_artist (library_item_id, artist_name, sort_order)
         VALUES (?, ?, ?)",
        rusqlite::params![library_item_id, artist_name, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The `addCustom` insert (library.repo.ts:355-357 `insert`, `:1565-1582`).
#[derive(Debug, Default)]
pub struct CustomInsert<'a> {
    pub gallery_id: Option<i64>,
    pub is_custom: i64,
    pub custom_title: &'a str,
    pub custom_tags: Option<&'a str>,
    pub custom_language: Option<&'a str>,
    pub custom_date: Option<&'a str>,
    pub custom_cover_path: Option<&'a str>,
    pub file_path: &'a str,
    pub file_size: i64,
    pub format: &'a str,
    pub primary_artist: &'a str,
    pub series_name: Option<&'a str>,
    pub description: Option<&'a str>,
    pub added_at_ms: i64,
}

pub fn insert_custom(conn: &Connection, item: &CustomInsert<'_>) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO library_item (gallery_id, is_custom, custom_title, custom_tags,
            custom_language, custom_date, custom_cover_path, file_path, file_size,
            format, primary_artist, series_name, description, read_progress,
            added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        rusqlite::params![
            item.gallery_id,
            item.is_custom,
            item.custom_title,
            item.custom_tags,
            item.custom_language,
            item.custom_date,
            item.custom_cover_path,
            item.file_path,
            item.file_size,
            item.format,
            item.primary_artist,
            item.series_name,
            item.description,
            item.added_at_ms,
            item.added_at_ms,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// reset (library.ipc.ts:1103-1111): the four table wipes, no vacuuming.
pub fn reset_library(conn: &Connection) -> Result<(), String> {
    for table in [
        "library_item_artist",
        "library_item",
        "library_scan_log",
        "scan_queue",
    ] {
        conn.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Series row tweaks (series.repo.ts) ─────────────────────────────────

/// `normaliseSeriesName` (series-grouping.ts:62-65): trim, empty → None.
pub fn normalise_series_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// renameRow (series.repo.ts:364-370): throws on an empty name; members are
/// updated by the caller.
pub fn series_rename_row(conn: &Connection, series_id: i64, name: &str, now_ms: i64) -> Result<(), String> {
    let trimmed =
        normalise_series_name(name).ok_or_else(|| "A series needs a name".to_string())?;
    conn.execute(
        "UPDATE series SET name = ?, is_manual = 1, updated_at = ? WHERE id = ?",
        rusqlite::params![trimmed, now_ms, series_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// setDissolved (series.repo.ts:323-343): dissolve unlinks members and
/// returns the unlink count; regroup relinks by name (NOCASE) and returns
/// the relink count. Timestamps are ms (`Date.now()`).
pub fn series_set_dissolved(
    conn: &Connection,
    series_id: i64,
    dissolved: bool,
    now_ms: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE series SET is_dissolved = ?, is_manual = 1, updated_at = ? WHERE id = ?",
        rusqlite::params![i64::from(dissolved), now_ms, series_id],
    )
    .map_err(|e| e.to_string())?;
    if dissolved {
        let n = conn
            .execute(
                "UPDATE library_item SET series_id = NULL WHERE series_id = ?",
                [series_id],
            )
            .map_err(|e| e.to_string())?;
        return Ok(n);
    }
    let name: Option<String> = conn
        .query_row("SELECT name FROM series WHERE id = ?", [series_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(name) = name else { return Ok(0) };
    let n = conn
        .execute(
            "UPDATE library_item SET series_id = ? WHERE series_name = ? COLLATE NOCASE",
            rusqlite::params![series_id, name],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// setCover (series.repo.ts:309-313): the path is name-normalised.
pub fn series_set_cover(
    conn: &Connection,
    series_id: i64,
    item_id: Option<i64>,
    path: Option<&str>,
    now_ms: i64,
) -> Result<(), String> {
    let cover_path = path.and_then(normalise_series_name);
    conn.execute(
        "UPDATE series SET cover_item_id = ?, cover_path = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![item_id, cover_path, now_ms, series_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
