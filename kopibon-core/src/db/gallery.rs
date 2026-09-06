//! gallery.repo.ts port — the API-response cache (id → raw_json).

use rusqlite::{Connection, OptionalExtension};

/// findById (gallery.repo.ts:9-11) as the raw_json text the pipeline parses.
pub fn find_raw_json_by_id(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT raw_json FROM gallery WHERE id = ?",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// findById (gallery.repo.ts:9-11) as the camelCase row `metaForItem` folds
/// into the metadata context (the cached gallery knows what the
/// `library_item` row does not: raw tags, upload date, titles, urls).
pub fn find_by_id(conn: &Connection, id: i64) -> Result<Option<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, media_id, title_pretty, title_english, title_japanese,
                    page_count, favorites_count, upload_date, thumbnail_url,
                    cover_url, raw_tags_json
             FROM gallery WHERE id = ?",
        )
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row(
            [id],
            |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "mediaId": r.get::<_, i64>(1)?,
                    "titlePretty": r.get::<_, String>(2)?,
                    "titleEnglish": r.get::<_, Option<String>>(3)?,
                    "titleJapanese": r.get::<_, Option<String>>(4)?,
                    "pageCount": r.get::<_, i64>(5)?,
                    "favoritesCount": r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    "uploadDate": r.get::<_, Option<i64>>(7)?,
                    "thumbnailUrl": r.get::<_, Option<String>>(8)?,
                    "coverUrl": r.get::<_, Option<String>>(9)?,
                    "rawTagsJson": r.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".to_string()),
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

/// upsert (gallery.repo.ts:20-34): whole-row replace keyed by id, with the
/// columns the pipeline writes. `raw_tags_json`/`raw_json` carry the
/// JSON.stringify output verbatim (byte parity of stored strings).
pub struct GalleryUpsert<'a> {
    pub id: i64,
    pub media_id: i64,
    pub title_pretty: &'a str,
    pub title_english: &'a str,
    pub title_japanese: Option<&'a str>,
    pub page_count: i64,
    pub favorites_count: i64,
    pub upload_date: Option<i64>,
    pub thumbnail_url: Option<&'a str>,
    pub cover_url: Option<&'a str>,
    pub raw_tags_json: &'a str,
    pub raw_json: &'a str,
}

pub fn upsert(conn: &Connection, g: &GalleryUpsert<'_>, now_s: i64) -> Result<(), String> {
    let updated = conn.execute(
        "UPDATE gallery SET media_id = ?, title_pretty = ?, title_english = ?, title_japanese = ?,
           page_count = ?, favorites_count = ?, upload_date = ?, thumbnail_url = ?, cover_url = ?,
           raw_tags_json = ?, raw_json = ?, updated_at = ?
         WHERE id = ?",
        rusqlite::params![
            g.media_id,
            g.title_pretty,
            g.title_english,
            g.title_japanese,
            g.page_count,
            g.favorites_count,
            g.upload_date,
            g.thumbnail_url,
            g.cover_url,
            g.raw_tags_json,
            g.raw_json,
            now_s,
            g.id
        ],
    )
    .map_err(|e| e.to_string())?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO gallery (id, media_id, title_pretty, title_english, title_japanese,
               page_count, favorites_count, upload_date, thumbnail_url, cover_url,
               raw_tags_json, raw_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                g.id,
                g.media_id,
                g.title_pretty,
                g.title_english,
                g.title_japanese,
                g.page_count,
                g.favorites_count,
                g.upload_date,
                g.thumbnail_url,
                g.cover_url,
                g.raw_tags_json,
                g.raw_json,
                now_s,
                now_s
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
