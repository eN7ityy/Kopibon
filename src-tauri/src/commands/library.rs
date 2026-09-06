//! `library:*` reads + `file:*`/`cbz:*` (02-ipc-surface §2.6–2.8,
//! `library.ipc.ts:388-986,1715-1733`).
//!
//! Thin envelope over the core repos: rows come back camelCase and are
//! hydrated once at this boundary (absolute `filePath`, absolute cover).
//! Mutations and long jobs live in `library_jobs.rs`.

use kopibon_core::db::search::LibraryFilterParams;
use serde_json::{json, Value};
use tauri::State;

use crate::envelope::{handle, CommandError, LogSink};
use crate::library::{hydrate_item, hydrate_items, library_root, resolve_cover_path};
use crate::state::AppState;

use super::forward;

pub(crate) fn opt_str(args: &[Value], i: usize) -> Option<String> {
    args.get(i).and_then(Value::as_str).map(|s| s.to_string())
}

pub(crate) fn opt_i64(args: &[Value], i: usize) -> Option<i64> {
    args.get(i).and_then(Value::as_i64)
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Renderer filter params → core params. Field names are the bridge's
/// (`artistFilters`, `showUnmatchedOnly`, …); the borrow of `owned`
/// keeps the slices alive.
pub(crate) fn filter_params<'a>(
    params: &'a Value,
    owned: &'a mut FilterOwned,
) -> LibraryFilterParams<'a> {
    owned.artists = str_list(params.get("artistFilters"));
    owned.series = str_list(params.get("seriesFilters"));
    owned.tags = str_list(params.get("tagFilters"));
    LibraryFilterParams {
        search_query: params.get("searchQuery").and_then(Value::as_str),
        artist_filters: &owned.artists,
        series_filters: &owned.series,
        tag_filters: &owned.tags,
        show_unmatched_only: params
            .get("showUnmatchedOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

#[derive(Default)]
pub(crate) struct FilterOwned {
    pub(crate) artists: Vec<String>,
    pub(crate) series: Vec<String>,
    pub(crate) tags: Vec<String>,
}

/// `library:getAll` (`:388-392`).
pub(crate) fn get_all_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let root = library_root(&state.db);
    let items = state
        .db
        .with_reader(kopibon_core::db::library_write::find_all_items)
        .map_err(CommandError::Thrown)?;
    Ok(json!({
        "success": true,
        "data": hydrate_items(&state.data_dir, &state.db, items, &root),
    }))
}

/// `library:getById` (`:394-409`): missing → null, resolved-or-stored
/// cover, gallery folded under `gallery`.
pub(crate) fn get_by_id_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = opt_i64(args, 0).unwrap_or(0);
    let row = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    let Some(row) = row else {
        return Ok(json!({ "success": true, "data": null }));
    };
    let root = library_root(&state.db);
    let mut item = hydrate_item(&state.data_dir, &state.db, &row, &root);
    let gallery = row
        .get("galleryId")
        .and_then(Value::as_i64)
        .and_then(|gid| {
            state
                .db
                .with_reader(|conn| kopibon_core::db::gallery::find_by_id(conn, gid))
                .ok()
                .flatten()
        });
    item["gallery"] = gallery.unwrap_or(Value::Null);
    Ok(json!({ "success": true, "data": item }))
}

/// `library:getAllIds` (`:411-430`): the cascade — gallery filter first
/// (matching members), else the flat filtered id list. Stale ids are
/// dropped with a warn; the empty list is a valid answer, never an error.
pub(crate) fn get_all_ids_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let params = args.first().cloned().unwrap_or(Value::Null);
    let gallery_id = params.get("galleryId").and_then(Value::as_i64);
    let mut owned = FilterOwned::default();
    let filter = filter_params(&params, &mut owned);
    let mut ids: Vec<i64> = if let Some(gid) = gallery_id {
        kopibon_core::db::library::matching_member_ids(&state.db, gid, &filter)
            .map_err(CommandError::Thrown)?
    } else {
        kopibon_core::db::library::find_all_ids(&state.db, &filter)
            .map_err(CommandError::Thrown)?
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_i64))
            .collect()
    };
    if ids.is_empty() {
        return Ok(json!({ "success": true, "data": ids }));
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let existing: Vec<i64> = state
        .db
        .with_reader(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT id FROM library_item WHERE id IN ({placeholders})"
                ))
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get(0))
                .map_err(|e| e.to_string())?;
            mapped
                .collect::<Result<Vec<i64>, _>>()
                .map_err(|e| e.to_string())
        })
        .map_err(CommandError::Thrown)?;
    if existing.len() != ids.len() {
        log(crate::envelope::LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "getAllIds: dropped stale ids".to_string(),
            fields: json!({ "requested": ids.len(), "existing": existing.len() }),
        });
        ids = existing;
    }
    Ok(json!({ "success": true, "data": ids }))
}

/// `library:getPaginated` (`:462-503`): offset/limit floor at 0, rows +
/// total, hydrated.
pub(crate) fn get_paginated_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let params = args.first().cloned().unwrap_or(Value::Null);
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(0) as usize;
    let sort = params.get("sortField").and_then(Value::as_str);
    let mut owned = FilterOwned::default();
    let filter = filter_params(&params, &mut owned);
    let (items, total) =
        kopibon_core::db::library::find_paginated(&state.db, &filter, offset, limit, sort)
            .map_err(CommandError::Thrown)?;
    let root = library_root(&state.db);
    Ok(json!({
        "success": true,
        "data": {
            "items": hydrate_items(&state.data_dir, &state.db, items, &root),
            "total": total,
        },
    }))
}

/// `library:getPaginatedGrouped` (`:505-544`): grouping off → flat page
/// wrapped as `kind:'item'` rows with `galleries == total`; on → the core
/// grouped page, item rows hydrated. Shape: `{ rows, total, galleries }`.
pub(crate) fn get_paginated_grouped_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let params = args.first().cloned().unwrap_or(Value::Null);
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(0) as usize;
    let sort = params.get("sortField").and_then(Value::as_str);
    let mut owned = FilterOwned::default();
    let filter = filter_params(&params, &mut owned);
    let root = library_root(&state.db);
    let grouping_on = state
        .db
        .with_reader(|conn| kopibon_core::db::settings::get(conn, "seriesGrouping"))
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if !grouping_on {
        let (items, total) =
            kopibon_core::db::library::find_paginated(&state.db, &filter, offset, limit, sort)
                .map_err(CommandError::Thrown)?;
        let rows: Vec<Value> = hydrate_items(&state.data_dir, &state.db, items, &root)
            .into_iter()
            .map(|item| json!({ "kind": "item", "item": item }))
            .collect();
        return Ok(json!({
            "success": true,
            "data": { "rows": rows, "total": total, "galleries": total },
        }));
    }
    let min_members: Option<i64> = state
        .db
        .with_reader(|conn| kopibon_core::db::settings::get(conn, "groupSeriesMin"))
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|n| *n >= 2);
    let (rows, total, galleries) = kopibon_core::db::library::find_paginated_grouped(
        &state.db,
        &filter,
        offset,
        limit,
        sort,
        min_members,
    )
    .map_err(CommandError::Thrown)?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            if row.get("kind").and_then(Value::as_str) == Some("item") {
                let mut row = row;
                if let Some(item) = row.get("item").cloned() {
                    row["item"] = hydrate_item(&state.data_dir, &state.db, &item, &root);
                }
                row
            } else {
                row
            }
        })
        .collect();
    Ok(json!({
        "success": true,
        "data": { "rows": rows, "total": total, "galleries": galleries },
    }))
}

/// `library:getSeriesMembers` (`:554-568`): matching member *ids* for the
/// series under the filter (the panel hydrates what it shows).
pub(crate) fn get_series_members_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_id = opt_i64(args, 0).unwrap_or(0);
    let params = args.get(1).cloned().unwrap_or(Value::Null);
    let mut owned = FilterOwned::default();
    let filter = filter_params(&params, &mut owned);
    let ids = kopibon_core::db::library::matching_member_ids(&state.db, series_id, &filter)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": ids }))
}

/// `library:getSeriesFacts` (`:577-629`): backfill null page counts
/// (chunks of 4, missing-file warns), then the whole-series facts.
/// Missing group → soft-fail `'That series no longer exists'`.
pub(crate) fn get_series_facts_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_id = opt_i64(args, 0).unwrap_or(0);
    let params = args.get(1).cloned().unwrap_or(Value::Null);
    let root = library_root(&state.db);
    let mut empty = FilterOwned::default();
    let empty_filter = filter_params(&Value::Null, &mut empty);
    let member_ids =
        kopibon_core::db::library::matching_member_ids(&state.db, series_id, &empty_filter)
            .map_err(CommandError::Thrown)?;
    for id in member_ids {
        let row = state
            .db
            .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
            .map_err(CommandError::Thrown)?;
        let Some(row) = row else { continue };
        if row.get("pageCount").and_then(Value::as_i64).is_some() {
            continue;
        }
        let stored = row.get("filePath").and_then(Value::as_str).unwrap_or("");
        let abs = kopibon_core::download::resolve_library_path(stored, &root);
        if !abs.exists() {
            log(crate::envelope::LogRecord {
                level: "warn",
                scope: "library".to_string(),
                message: "series facts: file not found".to_string(),
                fields: json!({ "id": id, "stored": stored }),
            });
            continue;
        }
        let format = row.get("format").and_then(Value::as_str);
        if let Some(pages) = kopibon_core::download::page_count::count_pages(&abs, format) {
            let _ = state.db.with_writer(|conn| {
                kopibon_core::db::library_write::update_item_fields(
                    conn,
                    id,
                    &[(
                        "pageCount".to_string(),
                        kopibon_core::db::library_write::FieldValue::Int(pages),
                    )],
                )
                .map(|_| ())
            });
        }
    }
    let mut owned = FilterOwned::default();
    let filter = filter_params(&params, &mut owned);
    let facts = kopibon_core::db::library::series_facts(&state.db, series_id, &filter)
        .map_err(CommandError::Thrown)?;
    let Some(facts) = facts else {
        return Ok(json!({ "success": false, "error": "That series no longer exists" }));
    };
    Ok(json!({ "success": true, "data": facts }))
}

/// `library:findSeries` (`:638-641`): null unless grouping is on and the
/// name really holds a group.
pub(crate) fn find_series_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let name = opt_str(args, 0).unwrap_or_default();
    let grouping_on = state
        .db
        .with_reader(|conn| kopibon_core::db::settings::get(conn, "seriesGrouping"))
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if !grouping_on {
        return Ok(json!({ "success": true, "data": null }));
    }
    let found = state
        .db
        .with_reader(|conn| {
            kopibon_core::db::series::find_displayable_by_name(
                conn,
                &name,
                kopibon_core::series_grouping::DEFAULT_MIN_SERIES_MEMBERS,
            )
        })
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": found }))
}

/// `library:getByGalleryId` (`:411-430`): row or null, hydrated.
pub(crate) fn get_by_gallery_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let gallery_id = opt_i64(args, 0).unwrap_or(0);
    let row = state
        .db
        .with_reader(|conn| {
            kopibon_core::db::library_write::find_item_by_gallery_id(conn, gallery_id)
        })
        .map_err(CommandError::Thrown)?;
    let root = library_root(&state.db);
    Ok(json!({
        "success": true,
        "data": row.map(|r| hydrate_item(&state.data_dir, &state.db, &r, &root)).unwrap_or(Value::Null),
    }))
}

/// `library:getGalleryTags` (`:444-459`): the cached typed tags, with the
/// scanner-stub guard (all-`tag` → []) and any parse failure → [].
pub(crate) fn get_gallery_tags_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let gallery_id = opt_i64(args, 0).unwrap_or(0);
    if gallery_id == 0 {
        return Ok(json!({ "success": true, "data": [] }));
    }
    let row = state
        .db
        .with_reader(|conn| kopibon_core::db::gallery::find_by_id(conn, gallery_id))
        .map_err(CommandError::Thrown)?;
    let tags: Value = row
        .as_ref()
        .and_then(|g| g.get("rawTagsJson"))
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(|parsed| {
            let types: std::collections::HashSet<&str> = parsed
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.get("type").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            !(types.len() <= 1 && types.contains("tag"))
        })
        .filter(|parsed| parsed.is_array())
        .unwrap_or(json!([]));
    Ok(json!({ "success": true, "data": tags }))
}

/// `library:search` (`:957-961`), `getArtists` (`:963-966`),
/// `getAllArtistNames` (`:968-971`), `getAllSeriesNames` (`:973-976`),
/// `getAllTagNames` (`:978-981`), `count` (`:983-986`).
pub(crate) fn search_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let query = opt_str(args, 0).unwrap_or_default();
    let items = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::search_items_by_title(conn, &query))
        .map_err(CommandError::Thrown)?;
    let root = library_root(&state.db);
    Ok(json!({
        "success": true,
        "data": hydrate_items(&state.data_dir, &state.db, items, &root),
    }))
}

pub(crate) fn get_artists_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = opt_i64(args, 0).unwrap_or(0);
    let artists = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::item_artists(conn, id))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": artists }))
}

pub(crate) fn get_all_artist_names_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let names = state
        .db
        .with_reader(kopibon_core::db::library_write::all_artist_names)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": names }))
}

pub(crate) fn get_all_series_names_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let names = state
        .db
        .with_reader(kopibon_core::db::library_write::all_series_names)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": names }))
}

pub(crate) fn get_all_tag_names_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let names = state
        .db
        .with_reader(kopibon_core::db::library_write::all_tag_names)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": names }))
}

pub(crate) fn count_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let count = kopibon_core::db::library::item_count(&state.db).map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": count }))
}

/// `library:getScanStatus` (`:1113-1119`): `{ scanning, lastScan }`.
pub(crate) fn get_scan_status_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let last = state
        .db
        .with_reader(kopibon_core::db::library_write::last_scan_log)
        .map_err(CommandError::Thrown)?;
    Ok(json!({
        "success": true,
        "data": {
            "scanning": state.library.scanning.load(std::sync::atomic::Ordering::SeqCst),
            "lastScan": last.unwrap_or(Value::Null),
        },
    }))
}

pub(crate) fn autocomplete_artists_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let query = opt_str(args, 0).unwrap_or_default();
    let names = kopibon_core::db::library::autocomplete_artists(&state.db, &query)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": names }))
}

pub(crate) fn autocomplete_series_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let query = opt_str(args, 0).unwrap_or_default();
    let names = kopibon_core::db::library::autocomplete_series(&state.db, &query)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": names }))
}

pub(crate) fn autocomplete_tags_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    // No DB autocomplete for tags (library.repo.ts:823-829): case-insensitive
    // substring over all names, first 10.
    let query = opt_str(args, 0).unwrap_or_default().to_lowercase();
    let names = state
        .db
        .with_reader(kopibon_core::db::library_write::all_tag_names)
        .map_err(CommandError::Thrown)?;
    let out: Vec<String> = names
        .into_iter()
        .filter(|n| n.to_lowercase().contains(&query))
        .take(10)
        .collect();
    Ok(json!({ "success": true, "data": out }))
}

/// `library:getPageCount` (`:830-849`): stored wins; else count from the
/// archive and backfill; missing row or file → null.
pub(crate) fn get_page_count_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = opt_i64(args, 0).unwrap_or(0);
    let row = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    let Some(row) = row else {
        return Ok(json!({ "success": true, "data": null }));
    };
    if let Some(stored) = row.get("pageCount").and_then(Value::as_i64) {
        return Ok(json!({ "success": true, "data": stored }));
    }
    let root = library_root(&state.db);
    let stored_path = row.get("filePath").and_then(Value::as_str).unwrap_or("");
    let abs = kopibon_core::download::resolve_library_path(stored_path, &root);
    if !abs.exists() {
        log(crate::envelope::LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "page count: file not found".to_string(),
            fields: json!({ "id": id, "stored": stored_path }),
        });
        return Ok(json!({ "success": true, "data": null }));
    }
    let format = row.get("format").and_then(Value::as_str);
    let pages = kopibon_core::download::page_count::count_pages(&abs, format);
    if let Some(pages) = pages {
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::library_write::update_item_fields(
                conn,
                id,
                &[(
                    "pageCount".to_string(),
                    kopibon_core::db::library_write::FieldValue::Int(pages),
                )],
            )
            .map(|_| ())
        });
    }
    Ok(json!({ "success": true, "data": pages }))
}

/// `library:getThumbnail` (`:1715-1726`): missing row/cover → null (with
/// a warn); else the JPEG data URI.
pub(crate) fn get_thumbnail_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    use base64::Engine;
    let id = opt_i64(args, 0).unwrap_or(0);
    let row = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    let Some(row) = row else {
        return Ok(json!({ "success": true, "data": null }));
    };
    let stored = row.get("customCoverPath").and_then(Value::as_str);
    let cover = resolve_cover_path(&state.data_dir, &state.db, stored);
    let Some(cover) = cover.filter(|p| p.exists()) else {
        log(crate::envelope::LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "thumbnail missing".to_string(),
            fields: json!({ "id": id, "storedCover": stored }),
        });
        return Ok(json!({ "success": true, "data": null }));
    };
    let bytes = std::fs::read(&cover).map_err(|e| CommandError::Thrown(e.to_string()))?;
    Ok(json!({
        "success": true,
        "data": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    }))
}

/// `library:isPathAccessible` (`:1728-1733`): plain existence probe.
pub(crate) fn is_path_accessible_impl(
    _state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let dir = opt_str(args, 0).unwrap_or_default();
    Ok(json!({ "success": true, "data": std::path::Path::new(&dir).exists() }))
}

/// `file:read` (`:2710-2716`): base64 of a file — SCOPED, unlike 1.x.
/// 02-ipc-surface §6 forbids reproducing the unguarded read: the path must
/// sit under the library root, the thumbnail dir, or the app data dir.
/// Outside → envelope error; missing → envelope error (1.x threw ENOENT).
pub(crate) fn file_read_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    use base64::Engine;
    let requested = opt_str(args, 0).unwrap_or_default();
    let path = std::path::Path::new(&requested);
    let canonical = path
        .canonicalize()
        .map_err(|e| CommandError::Thrown(e.to_string()))?;
    let allowed = [library_root(&state.db)]
        .into_iter()
        .map(std::path::PathBuf::from)
        .chain([
            crate::library::thumbnail_dir(&state.data_dir, &state.db),
            state.data_dir.clone(),
        ])
        .filter(|root| !root.as_os_str().is_empty())
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical.starts_with(&root));
    if !allowed {
        return Err(CommandError::Thrown(format!(
            "Access denied: {requested} is outside the library, thumbnails and app data"
        )));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| CommandError::Thrown(e.to_string()))?;
    Ok(json!({
        "success": true,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

/// `cbz:readPage` (`:2720-2875`): base64 of one page image. Out of range
/// → soft-fail `'Page not found'`; unreadable archive → envelope error.
pub(crate) fn cbz_read_page_impl(
    _state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    use base64::Engine;
    let file = opt_str(args, 0).unwrap_or_default();
    let index = args.get(1).and_then(Value::as_i64).unwrap_or(-1);
    if index < 0 {
        return Ok(json!({ "success": false, "error": "Page not found" }));
    }
    let page = crate::library::cbz_read_page(std::path::Path::new(&file), index as usize)
        .map_err(CommandError::Thrown)?;
    let Some(page) = page else {
        return Ok(json!({ "success": false, "error": "Page not found" }));
    };
    Ok(json!({
        "success": true,
        "data": base64::engine::general_purpose::STANDARD.encode(&page),
    }))
}

/// `cbz:getPageCount` (`:2877-2923`): image-entry count.
pub(crate) fn cbz_get_page_count_impl(
    _state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let file = opt_str(args, 0).unwrap_or_default();
    let entries = crate::library::cbz_image_entries(std::path::Path::new(&file))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": entries.len() }))
}

// __NEXT_E__

// ─── Wrappers ──────────────────────────────────────────────────────────

macro_rules! lib_read {
    ($name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $name(state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

lib_read!(library_get_all, "library:getAll", get_all_impl);
lib_read!(library_get_by_id, "library:getById", get_by_id_impl);
lib_read!(library_get_all_ids, "library:getAllIds", get_all_ids_impl);
lib_read!(
    library_get_paginated,
    "library:getPaginated",
    get_paginated_impl
);
lib_read!(
    library_get_paginated_grouped,
    "library:getPaginatedGrouped",
    get_paginated_grouped_impl
);
lib_read!(
    library_get_series_members,
    "library:getSeriesMembers",
    get_series_members_impl
);
lib_read!(
    library_get_series_facts,
    "library:getSeriesFacts",
    get_series_facts_impl
);
lib_read!(library_find_series, "library:findSeries", find_series_impl);
lib_read!(
    library_get_by_gallery_id,
    "library:getByGalleryId",
    get_by_gallery_impl
);
lib_read!(
    library_get_gallery_tags,
    "library:getGalleryTags",
    get_gallery_tags_impl
);
lib_read!(library_search, "library:search", search_impl);
lib_read!(library_get_artists, "library:getArtists", get_artists_impl);
lib_read!(
    library_get_all_artist_names,
    "library:getAllArtistNames",
    get_all_artist_names_impl
);
lib_read!(
    library_get_all_series_names,
    "library:getAllSeriesNames",
    get_all_series_names_impl
);
lib_read!(
    library_get_all_tag_names,
    "library:getAllTagNames",
    get_all_tag_names_impl
);
lib_read!(library_count, "library:count", count_impl);
lib_read!(
    library_get_scan_status,
    "library:getScanStatus",
    get_scan_status_impl
);
lib_read!(
    library_autocomplete_artists,
    "library:autocompleteArtists",
    autocomplete_artists_impl
);
lib_read!(
    library_autocomplete_series,
    "library:autocompleteSeries",
    autocomplete_series_impl
);
lib_read!(
    library_autocomplete_tags,
    "library:autocompleteTags",
    autocomplete_tags_impl
);
lib_read!(
    library_get_page_count,
    "library:getPageCount",
    get_page_count_impl
);
lib_read!(
    library_get_thumbnail,
    "library:getThumbnail",
    get_thumbnail_impl
);
lib_read!(
    library_is_path_accessible,
    "library:isPathAccessible",
    is_path_accessible_impl
);
lib_read!(file_read, "file:read", file_read_impl);
lib_read!(cbz_read_page, "cbz:readPage", cbz_read_page_impl);
lib_read!(
    cbz_get_page_count,
    "cbz:getPageCount",
    cbz_get_page_count_impl
);
