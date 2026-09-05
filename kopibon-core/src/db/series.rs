//! series.repo.ts port — the group lifecycle the grouped view and the
//! startup sweep need (findOrCreate, resolveFor, backfillAll, countVisible,
//! countVisibleFor). Raw SQL rather than a query builder because every
//! statement matches series names case-insensitively (series.repo.ts:12-16).

use rusqlite::{Connection, OptionalExtension};

use crate::series_grouping::{
    is_groupable_series_name, normalise_series_name, DEFAULT_MIN_SERIES_MEMBERS,
};

/// The series row (series.repo.ts:19-29).
#[derive(Debug, Clone)]
pub struct SeriesRow {
    pub id: i64,
    pub name: String,
    pub sort_name: Option<String>,
    pub cover_item_id: Option<i64>,
    pub cover_path: Option<String>,
    pub is_manual: i64,
    pub is_dissolved: i64,
}

/// What a resolve pass changed (series.repo.ts:32-41).
#[derive(Debug, Default, PartialEq)]
pub struct ResolveResult {
    pub names: Vec<String>,
    pub linked: i64,
    pub cleared: i64,
    pub visible_groups: i64,
}

fn row_to_series(row: &rusqlite::Row<'_>) -> rusqlite::Result<SeriesRow> {
    Ok(SeriesRow {
        id: row.get(0)?,
        name: row.get(1)?,
        sort_name: row.get(2)?,
        cover_item_id: row.get(3)?,
        cover_path: row.get(4)?,
        is_manual: row.get(5)?,
        is_dissolved: row.get(6)?,
    })
}

const SERIES_COLS: &str = "id, name, sort_name, cover_item_id, cover_path, is_manual, is_dissolved";

/// findById (series.repo.ts:44-46).
pub fn find_by_id(conn: &Connection, id: i64) -> Result<Option<SeriesRow>, String> {
    conn.query_row(
        &format!("SELECT {SERIES_COLS} FROM series WHERE id = ?"),
        [id],
        row_to_series,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// findByName (series.repo.ts:48-51).
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<SeriesRow>, String> {
    conn.query_row(
        &format!("SELECT {SERIES_COLS} FROM series WHERE name = ? COLLATE NOCASE"),
        [name],
        row_to_series,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// findOrCreate (series.repo.ts:61-73): INSERT OR IGNORE then select —
/// check-then-insert loses the scanner/worker race against the unique index.
/// `now_s` stamps created_at/updated_at (1.x wrote `Date.now()` ms; the port
/// writes seconds per 03-data-model §10.5).
pub fn find_or_create(conn: &Connection, name: &str, now_s: i64) -> Result<SeriesRow, String> {
    let trimmed =
        normalise_series_name(Some(name)).ok_or_else(|| "A series needs a name".to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO series (name, created_at, updated_at) VALUES (?, ?, ?)",
        rusqlite::params![trimmed, now_s, now_s],
    )
    .map_err(|e| e.to_string())?;

    find_by_name(conn, &trimmed)?.ok_or_else(|| format!("Could not create the series \"{trimmed}\""))
}

/// resolveFor (series.repo.ts:88-144): link items to their group and pull in
/// everything else sharing the name — linking is by *name* across the whole
/// library, idempotent, and clears the link of unusable names.
pub fn resolve_for(
    conn: &mut Connection,
    item_ids: &[i64],
    now_s: i64,
) -> Result<ResolveResult, String> {
    if item_ids.is_empty() {
        return Ok(ResolveResult::default());
    }

    let placeholders = vec!["?"; item_ids.len()].join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, series_name FROM library_item WHERE id IN ({placeholders})"
        ))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, Option<String>)> = stmt
        .query_map(rusqlite::params_from_iter(item_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    // Distinct names, keyed case-insensitively so one group is resolved once
    // even when the members spell it differently (:99-110).
    let mut names: Vec<(String, String)> = Vec::new(); // (lower, display)
    let mut unusable: Vec<i64> = Vec::new();
    for (id, series_name) in rows {
        if is_groupable_series_name(series_name.as_deref()) {
            let name = normalise_series_name(series_name.as_deref())
                .expect("groupable implies normalisable");
            if !names.iter().any(|(k, _)| *k == name.to_lowercase()) {
                names.push((name.to_lowercase(), name));
            }
        } else {
            unusable.push(id);
        }
    }

    let mut result = ResolveResult::default();
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (_, name) in &names {
            let group = find_or_create(&tx, name, now_s)?;
            // A group someone broke up stays broken up (:127-129).
            if group.is_dissolved != 0 {
                continue;
            }
            result.linked += tx
                .execute(
                    "UPDATE library_item SET series_id = ?
                      WHERE series_name = ? COLLATE NOCASE
                        AND (series_id IS NULL OR series_id != ?)",
                    rusqlite::params![group.id, name, group.id],
                )
                .map_err(|e| e.to_string())? as i64;
        }
        for id in &unusable {
            result.cleared += tx
                .execute(
                    "UPDATE library_item SET series_id = NULL WHERE id = ? AND series_id IS NOT NULL",
                    [id],
                )
                .map_err(|e| e.to_string())? as i64;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    result.names = names.into_iter().map(|(_, display)| display).collect();
    result.visible_groups = count_visible_for(conn, &result.names, DEFAULT_MIN_SERIES_MEMBERS)?;
    Ok(result)
}

/// countVisibleFor (series.repo.ts:147-161).
pub fn count_visible_for(conn: &Connection, names: &[String], min: i64) -> Result<i64, String> {
    if names.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["? COLLATE NOCASE"; names.len()].join(",");
    let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(names.len() + 1);
    for n in names {
        bind.push(n);
    }
    bind.push(&min);
    let n: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) AS n FROM (
                   SELECT li.series_id FROM library_item li
                     JOIN series s ON s.id = li.series_id
                    WHERE s.name IN ({placeholders})
                    GROUP BY li.series_id HAVING COUNT(*) >= ?
                 )"
            ),
            bind.as_slice(),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// countVisible (series.repo.ts:260-270).
pub fn count_visible(conn: &Connection, min: i64) -> Result<i64, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) AS n FROM (
               SELECT series_id FROM library_item WHERE series_id IS NOT NULL
                GROUP BY series_id HAVING COUNT(*) >= ?
             )",
            [min],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// backfillAll (series.repo.ts:170-231): link every item in the library, one
/// transaction, one whole-table statement.
pub fn backfill_all(conn: &mut Connection, now_s: i64) -> Result<ResolveResult, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT series_name FROM library_item
              WHERE series_name IS NOT NULL AND trim(series_name) != ''",
        )
        .map_err(|e| e.to_string())?;
    let distinct: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut names: Vec<(String, String)> = Vec::new();
    for series_name in distinct {
        if !is_groupable_series_name(Some(&series_name)) {
            continue;
        }
        let name = normalise_series_name(Some(&series_name)).expect("checked groupable");
        if !names.iter().any(|(k, _)| *k == name.to_lowercase()) {
            names.push((name.to_lowercase(), name));
        }
    }

    let mut result = ResolveResult::default();
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (_, name) in &names {
            tx.execute(
                "INSERT OR IGNORE INTO series (name, created_at, updated_at) VALUES (?, ?, ?)",
                rusqlite::params![name, now_s, now_s],
            )
            .map_err(|e| e.to_string())?;
        }

        // One statement for the whole library (:200-211). Non-groupable names
        // resolve to NULL through the correlated subquery.
        result.linked = tx
            .execute(
                "UPDATE library_item
                    SET series_id = (SELECT s.id FROM series s
                                      WHERE s.name = library_item.series_name COLLATE NOCASE
                                        AND s.is_dissolved = 0)
                  WHERE series_id IS NOT (SELECT s.id FROM series s
                                           WHERE s.name = library_item.series_name COLLATE NOCASE
                                             AND s.is_dissolved = 0)",
                [],
            )
            .map_err(|e| e.to_string())? as i64;

        result.cleared = tx
            .execute(
                "UPDATE library_item SET series_id = NULL
                  WHERE series_id IS NOT NULL
                    AND (series_name IS NULL OR trim(series_name) = '')",
                [],
            )
            .map_err(|e| e.to_string())? as i64;
        tx.commit().map_err(|e| e.to_string())?;
    }

    result.names = names.into_iter().map(|(_, display)| display).collect();
    result.visible_groups = count_visible(conn, DEFAULT_MIN_SERIES_MEMBERS)?;
    Ok(result)
}
