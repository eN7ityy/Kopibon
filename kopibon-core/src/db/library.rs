//! library.repo.ts port — the read methods the Phase A gate needs
//! (findPaginated, findAllIds, the autocompletes). Rows are returned as
//! column-name → JSON value maps so the differential harness can compare
//! row-for-row against better-sqlite3 regardless of column order.

use super::connection::Db;
use super::search::{build_library_filter, LibraryFilterParams};
use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;
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

// ─── The grouped view (library.repo.ts:100-295, 482-592) ────────────────────

/// library_item column → the camelCase name Drizzle's typed select returns
/// (schema.ts:24-72). The grouped ops compare against the real repo, which
/// hands out camelCase rows.
fn camel_case_column(name: &str) -> String {
    match name {
        "gallery_id" => "galleryId",
        "is_custom" => "isCustom",
        "custom_title" => "customTitle",
        "custom_tags" => "customTags",
        "custom_language" => "customLanguage",
        "custom_date" => "customDate",
        "custom_cover_path" => "customCoverPath",
        "file_path" => "filePath",
        "file_size" => "fileSize",
        "primary_artist" => "primaryArtist",
        "series_name" => "seriesName",
        "series_index" => "seriesIndex",
        "series_id" => "seriesId",
        "page_count" => "pageCount",
        "read_progress" => "readProgress",
        "file_mtime" => "fileMtime",
        "thumbnail_path" => "thumbnailPath",
        "added_at" => "addedAt",
        "updated_at" => "updatedAt",
        other => return other.to_string(),
    }
    .to_string()
}

/// query → Vec of camelCase JSON objects (drizzle select shape).
fn select_camel_items(
    conn: &rusqlite::Connection,
    sql: &str,
    bind: &[SqlValue],
) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| camel_case_column(s))
        .collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind.iter()), |row| {
            row_to_json(&col_names, row)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// (id, name, sort_name, cover_item_id, cover_path) — the series row slice
/// the grouped queries read.
type GroupMeta = (i64, String, Option<String>, Option<i64>, Option<String>);

/// One entry of the thin index (library.repo.ts:558-560).
#[derive(Debug, Clone)]
struct IndexEntry {
    kind: String,
    id: i64,
}

/// The grouped union (library.repo.ts:501-538). `filter_sql` is the bare
/// predicate (empty string → the TS `?? sql`1`` fallback); it references
/// `library_item` unaliased so it resolves inside each branch (:509-512).
fn grouped_union_sql(filter_sql: &str, limit: usize, offset: usize, order_by: &str) -> (String, String) {
    let filter = if filter_sql.is_empty() { "1" } else { filter_sql };
    let grouped = "SELECT series_id, COUNT(*) AS total
           FROM library_item
          WHERE series_id IS NOT NULL
          GROUP BY series_id
         HAVING COUNT(*) >= ?";
    // min is an internal constant (DEFAULT_MIN_SERIES_MEMBERS), never user
    // input — inlined exactly as the TS template does.
    let unioned = format!(
        "SELECT 'series' AS kind,
                s.id AS id,
                COALESCE(s.sort_name, s.name) AS sort_title,
                MIN(library_item.primary_artist) FILTER (WHERE {filter}) AS sort_artist,
                MAX(library_item.added_at) FILTER (WHERE {filter}) AS sort_added,
                COUNT(*) FILTER (WHERE {filter}) AS match_count,
                g.total AS total_count
           FROM series s
           JOIN ({grouped}) g ON g.series_id = s.id
           JOIN library_item ON library_item.series_id = s.id
          GROUP BY s.id
         HAVING match_count > 0
         UNION ALL
         SELECT 'item',
                library_item.id,
                library_item.custom_title,
                library_item.primary_artist,
                library_item.added_at,
                1,
                1
           FROM library_item
          WHERE (library_item.series_id IS NULL
                 OR library_item.series_id NOT IN (SELECT series_id FROM ({grouped})))
            AND {filter}"
    );
    let index_sql = format!(
        "SELECT * FROM ({unioned}) ORDER BY {order_by} LIMIT {limit} OFFSET {offset}"
    );
    let totals_sql =
        format!("SELECT COUNT(*) AS rows, COALESCE(SUM(match_count), 0) AS galleries FROM ({unioned})");
    (index_sql, totals_sql)
}

/// Parameter binding order follows the rendered SQL text: the series branch's
/// three FILTER clauses come first, then its JOIN's grouped threshold, then
/// the item branch's NOT-IN threshold and WHERE filter.
fn grouped_params(filter_params: &[SqlValue], min: i64) -> Vec<SqlValue> {
    let mut params = Vec::new();
    for _ in 0..3 {
        params.extend(filter_params.iter().cloned());
    }
    params.push(SqlValue::Integer(min));
    params.push(SqlValue::Integer(min));
    params.extend(filter_params.iter().cloned());
    params
}

fn grouped_order_by(sort_field: Option<&str>) -> &'static str {
    match sort_field {
        // A series sorts under its alphabetically first contributing artist
        // (library.repo.ts:546-550).
        Some("title") => "sort_title COLLATE NOCASE ASC",
        Some("artist") => "sort_artist COLLATE NOCASE ASC",
        _ => "sort_added DESC",
    }
}

/// A member row of a series, as the card computation needs it
/// (MemberRow, library.repo.ts:162-175).
#[derive(Debug, Clone)]
struct MemberRow {
    id: i64,
    series_id: i64,
    series_index: Option<f64>,
    custom_title: Option<String>,
    format: Option<String>,
    language: Option<String>,
    custom_language: Option<String>,
    primary_artist: Option<String>,
    custom_tags: Option<String>,
    file_size: Option<i64>,
    added_at: i64,
    matches: bool,
}

const MEMBER_COLS: &str = "id, series_id, series_index, custom_title, format, language, \
     custom_language, primary_artist, custom_tags, file_size, added_at";

fn member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemberRow> {
    Ok(MemberRow {
        id: row.get(0)?,
        series_id: row.get(1)?,
        series_index: row.get(2)?,
        custom_title: row.get(3)?,
        format: row.get(4)?,
        language: row.get(5)?,
        custom_language: row.get(6)?,
        primary_artist: row.get(7)?,
        custom_tags: row.get(8)?,
        file_size: row.get(9)?,
        added_at: row.get(10)?,
        matches: false,
    })
}

fn member_facts_input(m: &MemberRow) -> crate::series_grouping::FactsMember<'_> {
    crate::series_grouping::FactsMember {
        format: m.format.as_deref(),
        language: m.language.as_deref(),
        custom_language: m.custom_language.as_deref(),
        primary_artist: m.primary_artist.as_deref(),
        custom_tags: m.custom_tags.as_deref(),
    }
}

fn member_series_member(m: &MemberRow) -> crate::series_grouping::SeriesMember {
    crate::series_grouping::SeriesMember {
        id: m.id,
        series_index: m.series_index,
        title: m.custom_title.clone().unwrap_or_default(),
    }
}

/// Reading order for rows shaped as they come out of SQL
/// (sortSeriesMembersRows, library.repo.ts:152-160).
fn sort_member_rows(rows: &mut [MemberRow]) {
    let mut keys: Vec<crate::series_grouping::SeriesMember> =
        rows.iter().map(member_series_member).collect();
    crate::series_grouping::sort_series_members(&mut keys);
    let order: Vec<i64> = keys.iter().map(|k| k.id).collect();
    rows.sort_by_key(|r| order.iter().position(|id| *id == r.id).unwrap_or(usize::MAX));
}

/// Turn the thin index into the rows the grid renders
/// (hydrateRows, library.repo.ts:183-295).
#[allow(clippy::too_many_arguments)]
fn hydrate_rows(
    conn: &rusqlite::Connection,
    index: &[IndexEntry],
    filter_params: &[SqlValue],
    filter_sql: &str,
) -> Result<Vec<Value>, String> {
    let filter = if filter_sql.is_empty() { "1" } else { filter_sql };
    let item_ids: Vec<i64> = index
        .iter()
        .filter(|r| r.kind == "item")
        .map(|r| r.id)
        .collect();
    let series_ids: Vec<i64> = index
        .iter()
        .filter(|r| r.kind == "series")
        .map(|r| r.id)
        .collect();

    let mut items_by_id: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
    if !item_ids.is_empty() {
        let placeholders = vec!["?"; item_ids.len()].join(", ");
        let rows = select_camel_items(
            conn,
            &format!("SELECT * FROM library_item WHERE id IN ({placeholders})"),
            &item_ids.iter().map(|i| SqlValue::Integer(*i)).collect::<Vec<_>>(),
        )?;
        for item in rows {
            let id = item.get("id").and_then(Value::as_i64).unwrap_or(0);
            items_by_id.insert(id, item);
        }
    }

    let mut cards_by_id: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
    if !series_ids.is_empty() {
        let placeholders = vec!["?"; series_ids.len()].join(", ");
        let series_bind: Vec<SqlValue> = series_ids
            .iter()
            .map(|i| SqlValue::Integer(*i))
            .collect();

        let groups: Vec<GroupMeta> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT id, name, sort_name, cover_item_id, cover_path FROM series
                      WHERE id IN ({placeholders})"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(series_bind.iter()), |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Every member of every series on this page, carrying whether it
        // matched — fetching all members is what keeps the cover stable under
        // a filter while the facts follow the match (:218-221).
        let members: Vec<(i64, MemberRow)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEMBER_COLS},
                            CASE WHEN {filter} THEN 1 ELSE 0 END AS matches
                       FROM library_item
                      WHERE series_id IN ({placeholders})"
                ))
                .map_err(|e| e.to_string())?;
            // Text order: the CASE filter in the select list binds before
            // the WHERE's series ids.
            let mut bind = filter_params.to_vec();
            bind.extend(series_bind.iter().cloned());
            let rows = stmt
                .query_map(rusqlite::params_from_iter(bind.iter()), |r| {
                    let mut m = member_from_row(r)?;
                    m.matches = r.get::<_, i64>(11)? == 1;
                    Ok(m)
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok())
                .map(|m| Ok((m.id, m)))
                .collect::<Result<Vec<_>, String>>()?
        };

        let mut by_series: std::collections::HashMap<i64, Vec<MemberRow>> =
            std::collections::HashMap::new();
        for (_, m) in members.into_iter() {
            by_series.entry(m.series_id).or_default().push(m);
        }

        for (id, name, sort_name, cover_item_id, cover_path) in &groups {
            let all: Vec<MemberRow> = by_series.remove(id).unwrap_or_default();
            let matching: Vec<&MemberRow> = all.iter().filter(|m| m.matches).collect();

            // Facts describe what matched (:242-246).
            let facts = crate::series_grouping::merge_series_facts(
                &matching.iter().map(|m| member_facts_input(m)).collect::<Vec<_>>(),
            );

            let cover = crate::series_grouping::pick_series_cover(
                &all.iter().map(member_series_member).collect::<Vec<_>>(),
                *cover_item_id,
                cover_path.as_deref(),
            );

            let sort_key = js_trim_or_empty(sort_name.as_deref());
            let display_name = if sort_key.is_empty() {
                name.clone()
            } else {
                sort_key.to_string()
            };

            let mut sorted_matching = matching.iter().map(|m| (*m).clone()).collect::<Vec<_>>();
            sort_member_rows(&mut sorted_matching);

            cards_by_id.insert(
                *id,
                json!({
                    "id": id,
                    "name": display_name,
                    "matchCount": matching.len(),
                    "totalCount": all.len(),
                    "addedAt": matching.iter().map(|m| m.added_at).max().unwrap_or(0),
                    "fileSize": matching.iter().map(|m| m.file_size.unwrap_or(0)).sum::<i64>(),
                    "coverItemId": match &cover { Some(crate::series_grouping::Cover::Member(id)) => json!(id), _ => Value::Null },
                    "coverPath": match &cover { Some(crate::series_grouping::Cover::Path(p)) => json!(p), _ => Value::Null },
                    "format": facts.format,
                    "artists": facts.artists,
                    "languages": facts.languages,
                    "tags": facts.tags,
                    // Gaps describe the series, not the filtered slice (:272-275).
                    "gaps": crate::series_grouping::find_volume_gaps(
                        &all.iter().map(|m| m.series_index).collect::<Vec<_>>(),
                    ),
                    "members": sorted_matching.iter().map(|m| json!({
                        "id": m.id,
                        // m.format || 'pdf' — null or '' falls through.
                        "format": match m.format.as_deref() { Some(f) if !f.is_empty() => json!(f), _ => json!("pdf") },
                    })).collect::<Vec<_>>(),
                }),
            );
        }
    }

    let mut rows = Vec::new();
    for entry in index {
        if entry.kind == "item" {
            if let Some(item) = items_by_id.get(&entry.id) {
                rows.push(json!({"kind": "item", "item": item}));
            }
        } else if let Some(series) = cards_by_id.get(&entry.id) {
            rows.push(json!({"kind": "series", "series": series}));
        }
    }
    Ok(rows)
}

fn js_trim_or_empty(s: Option<&str>) -> &str {
    match s {
        Some(v) => crate::metadata::xml_utils::js_trim(v),
        None => "",
    }
}

/// findPaginatedGrouped (library.repo.ts:482-574): one page of the library
/// with series collapsed into single rows. Returns (rows, total, galleries).
pub fn find_paginated_grouped(
    db: &Db,
    params: &LibraryFilterParams,
    offset: usize,
    limit: usize,
    sort_field: Option<&str>,
    min_members: Option<i64>,
) -> Result<(Vec<Value>, i64, i64), String> {
    let min = min_members.unwrap_or(crate::series_grouping::DEFAULT_MIN_SERIES_MEMBERS);
    db.with_reader(|conn| {
        let filter = build_library_filter(params);
        let (filter_sql, filter_params): (String, Vec<SqlValue>) = match &filter {
            Some(f) => (f.sql.clone(), f.params.clone()),
            None => (String::new(), Vec::new()),
        };

        let (index_sql, totals_sql) =
            grouped_union_sql(&filter_sql, limit, offset, grouped_order_by(sort_field));
        let bind = grouped_params(&filter_params, min);

        let index: Vec<IndexEntry> = {
            let mut stmt = conn.prepare(&index_sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params_from_iter(bind.iter()), |r| {
                Ok(IndexEntry {
                    kind: r.get::<_, String>(0)?,
                    id: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Two counts: rows the grid scrolls through, and galleries that
        // actually matched (:562-565).
        let totals: (i64, i64) = conn
            .query_row(
                &totals_sql,
                rusqlite::params_from_iter(bind.iter()),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;

        let rows = hydrate_rows(conn, &index, &filter_params, &filter_sql)?;
        Ok((rows, totals.0, totals.1))
    })
}

/// matchingMemberIds (library.repo.ts:583-592): the matching members of one
/// group, in reading order.
pub fn matching_member_ids(
    db: &Db,
    series_id: i64,
    params: &LibraryFilterParams,
) -> Result<Vec<i64>, String> {
    db.with_reader(|conn| {
        let filter = build_library_filter(params);
        let (filter_sql, filter_params): (String, Vec<SqlValue>) = match &filter {
            Some(f) => (f.sql.clone(), f.params.clone()),
            None => ("1".to_string(), Vec::new()),
        };
        let mut rows: Vec<MemberRow> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEMBER_COLS} FROM library_item
                      WHERE series_id = ? AND {filter_sql}"
                ))
                .map_err(|e| e.to_string())?;
            let mut bind = vec![SqlValue::Integer(series_id)];
            bind.extend(filter_params);
            let mapped = stmt
                .query_map(rusqlite::params_from_iter(bind.iter()), member_from_row)
                .map_err(|e| e.to_string())?;
            mapped.filter_map(|r| r.ok()).collect()
        };
        sort_member_rows(&mut rows);
        Ok(rows.iter().map(|m| m.id).collect())
    })
}

/// seriesFacts (library.repo.ts:606-759): everything the series detail panel
/// shows, in one call — the WHOLE series with a match flag on each member.
pub fn series_facts(
    db: &Db,
    series_id: i64,
    params: &LibraryFilterParams,
) -> Result<Option<Value>, String> {
    db.with_reader(|conn| {
        let filter = build_library_filter(params);
        let (filter_sql, filter_params): (String, Vec<SqlValue>) = match &filter {
            Some(f) => (f.sql.clone(), f.params.clone()),
            None => ("1".to_string(), Vec::new()),
        };
        let filter = if filter_sql.is_empty() { "1" } else { &filter_sql };

        let group: Option<GroupMeta> = {
            let mut stmt = conn
                .prepare("SELECT id, name, sort_name, cover_item_id, cover_path FROM series WHERE id = ?")
                .map_err(|e| e.to_string())?;
            stmt.query_row([series_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .optional()
            .map_err(|e| e.to_string())?
        };
        let Some((id, name, sort_name, cover_item_id, cover_path)) = group else {
            return Ok(None);
        };

        // Whole-series members with the match flag (camelCase, drizzle shape).
        // Text order: the CASE filter in the select list binds before the
        // WHERE's series_id.
        let mut fact_bind: Vec<SqlValue> = filter_params.clone();
        fact_bind.push(SqlValue::Integer(series_id));
        let mut member_items = select_camel_items(
            conn,
            &format!(
                "SELECT *, CASE WHEN {filter} THEN 1 ELSE 0 END AS matches
                  FROM library_item WHERE series_id = ?"
            ),
            &fact_bind,
        )?;
        // matches came back as 1/0 from the CASE; convert the column to a
        // boolean in place and keep the flags for the counts below.
        let match_flags: Vec<bool> = member_items
            .iter()
            .map(|m| m.get("matches").and_then(Value::as_i64).unwrap_or(0) == 1)
            .collect();
        for (m, flag) in member_items.iter_mut().zip(&match_flags) {
            if let Some(o) = m.as_object_mut() {
                o.insert("matches".to_string(), Value::Bool(*flag));
            }
        }

        // Reading order via sortSeriesMembers over the typed rows.
        let mut keys: Vec<crate::series_grouping::SeriesMember> = member_items
            .iter()
            .map(|m| crate::series_grouping::SeriesMember {
                id: m.get("id").and_then(Value::as_i64).unwrap_or(0),
                series_index: m.get("seriesIndex").and_then(Value::as_f64),
                title: m
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .collect();
        crate::series_grouping::sort_series_members(&mut keys);
        let order: Vec<i64> = keys.iter().map(|k| k.id).collect();
        member_items.sort_by_key(|m| {
            let id = m.get("id").and_then(Value::as_i64).unwrap_or(0);
            order.iter().position(|o| *o == id).unwrap_or(usize::MAX)
        });

        let facts_input: Vec<crate::series_grouping::FactsMember<'_>> = member_items
            .iter()
            .map(|m| crate::series_grouping::FactsMember {
                format: m.get("format").and_then(Value::as_str),
                language: m.get("language").and_then(Value::as_str),
                custom_language: m.get("customLanguage").and_then(Value::as_str),
                primary_artist: m.get("primaryArtist").and_then(Value::as_str),
                custom_tags: m.get("customTags").and_then(Value::as_str),
            })
            .collect();
        let facts = crate::series_grouping::merge_series_facts(&facts_input);

        // Typed tags — genre, parody, character — from the cached gallery rows
        // (:692-731). Scanner stubs store every tag as type 'tag' and are
        // skipped exactly as library:getGalleryTags skips them.
        let gallery_ids: Vec<i64> = member_items
            .iter()
            .filter_map(|m| m.get("galleryId").and_then(Value::as_i64))
            .collect();
        let mut typed_tags: Vec<Value> = Vec::new();
        if !gallery_ids.is_empty() {
            let placeholders = vec!["?"; gallery_ids.len()].join(", ");
            let bind: Vec<SqlValue> = gallery_ids
                .iter()
                .map(|i| SqlValue::Integer(*i))
                .collect();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT raw_tags_json FROM gallery WHERE id IN ({placeholders})"
                ))
                .map_err(|e| e.to_string())?;
            let raw: Vec<Option<String>> = stmt
                .query_map(rusqlite::params_from_iter(bind.iter()), |r| r.get(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for row in raw {
                let Some(json_str) = row else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&json_str) else {
                    continue;
                };
                let Some(arr) = parsed.as_array() else { continue };
                let types: std::collections::HashSet<&str> = arr
                    .iter()
                    .filter_map(|t| t.get("type").and_then(Value::as_str))
                    .collect();
                if types.len() <= 1 && types.contains("tag") {
                    continue;
                }
                for tag in arr {
                    let (Some(tag_type), Some(tag_name)) = (
                        tag.get("type").and_then(Value::as_str),
                        tag.get("name").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    let key = format!(
                        "{tag_type}\u{0}{}",
                        tag_name.chars().flat_map(char::to_lowercase).collect::<String>()
                    );
                    if !seen.insert(key) {
                        continue;
                    }
                    typed_tags.push(json!({
                        "id": tag.get("id").and_then(Value::as_i64).unwrap_or(0),
                        "type": tag_type,
                        "name": tag_name,
                    }));
                }
            }
        }

        let cover = crate::series_grouping::pick_series_cover(
            &keys,
            cover_item_id,
            cover_path.as_deref(),
        );

        let match_count = match_flags.iter().filter(|f| **f).count();
        let total_size: i64 = member_items
            .iter()
            .map(|m| m.get("fileSize").and_then(Value::as_i64).unwrap_or(0))
            .sum();
        let page_counts: Vec<Option<i64>> = member_items
            .iter()
            .map(|m| m.get("pageCount").and_then(Value::as_i64))
            .collect();
        let page_count = if page_counts.iter().any(|p| p.is_some()) {
            Value::from(page_counts.iter().flatten().sum::<i64>())
        } else {
            Value::Null
        };

        let sort_key = js_trim_or_empty(sort_name.as_deref());
        let display_name = if sort_key.is_empty() { name } else { sort_key.to_string() };
        Ok(Some(json!({
            "id": id,
            "name": display_name,
            "sortName": sort_name,
            "coverItemId": match &cover { Some(crate::series_grouping::Cover::Member(cid)) => json!(cid), _ => Value::Null },
            "coverPath": match &cover { Some(crate::series_grouping::Cover::Path(p)) => json!(p), _ => Value::Null },
            "matchCount": match_count,
            "totalCount": member_items.len(),
            "fileSize": total_size,
            "pageCount": page_count,
            "artists": facts.artists,
            "languages": facts.languages,
            "tags": facts.tags,
            "gaps": crate::series_grouping::find_volume_gaps(
                &member_items.iter().map(|m| m.get("seriesIndex").and_then(Value::as_f64)).collect::<Vec<_>>(),
            ),
            "typedTags": typed_tags,
            "members": member_items,
        })))
    })
}
