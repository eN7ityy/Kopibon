//! `library:*` mutations (`library.ipc.ts:666-801,862-955,1140-1713`).
//!
//! Row writes go through the core `library_write` allowlist (unknown keys
//! silently dropped, exactly like drizzle); file work (embed, move, copy)
//! runs inline; Kavita hooks fire and forget. Every handler refuses locked
//! rows with the shared [`conversion_lock_error`](crate::library::conversion_lock_error).

use kopibon_core::db::library_write::FieldValue;
use kopibon_core::kavita::KavitaClient;
use kopibon_core::metadata::context::FileMetadataOverrides;
use kopibon_core::metadata::mappers::{Clock, SystemClock};
use serde_json::{json, Value};
use tauri::State;

use crate::commands::library::{filter_params, opt_i64, opt_str, FilterOwned};
use crate::envelope::{handle, CommandError, LogRecord, LogSink};
use crate::kavita::{effective_config, is_enabled};
use crate::library::{
    conversion_lock_error, cover_filename, default_overrides, library_root, meta_for_item,
    rename_thumbnail_for_path,
};
use crate::state::AppState;

use super::forward;

/// Current file mtime as secs (the CBZ entry stamp + PDF fallback); now on
/// any failure. TS embeds never preserved or pinned mtimes — the stamp just
/// travels with the rewrite.
fn file_mtime_secs(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        })
}

/// `renameForGalleryId` (`:876-918`): bring the filename in line with the
/// attached id (best-effort — a failed move never undoes the attach).
/// Returns extra row fields (filePath + moved cover columns).
fn rename_for_gallery_id(
    state: &AppState,
    item: &Value,
    gallery_id: Option<i64>,
    log: &mut LogSink,
) -> Value {
    let root = library_root(&state.db);
    let stored = item.get("filePath").and_then(Value::as_str).unwrap_or("");
    let item_path = kopibon_core::download::resolve_library_path(stored, &root);
    if !item_path.exists() {
        log(LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "rename for gallery id: file not found".to_string(),
            fields: json!({ "id": item.get("id"), "stored": stored }),
        });
        return json!({});
    }
    let file_name = item_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let next_name = kopibon_core::metadata::filenames::apply_gallery_id_to_filename(
        file_name,
        gallery_id.map(|g| g as u32),
    );
    let next_path = item_path.with_file_name(&next_name);
    if next_path == item_path {
        return json!({});
    }
    if next_path.exists() {
        log(LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "skipped rename: a file already has that name".to_string(),
            fields: json!({ "to": next_path.to_string_lossy() }),
        });
        return json!({});
    }
    if std::fs::rename(&item_path, &next_path).is_err() {
        log(LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: "could not rename after changing the nhentai id".to_string(),
            fields: json!({ "from": item_path.to_string_lossy() }),
        });
        return json!({});
    }
    let mut extra = json!({
        "filePath": kopibon_core::download::relativize_library_path(&next_path, &root),
    });
    let current_cover = item.get("customCoverPath").and_then(Value::as_str);
    if let Some(moved) = rename_thumbnail_for_path(
        &state.data_dir,
        &state.db,
        current_cover,
        &next_path.to_string_lossy(),
    ) {
        extra["customCoverPath"] = json!(&moved);
        extra["thumbnailPath"] = json!(moved);
    }
    extra
}

/// Fire-and-forget Kavita delete (`deleteItemsFromKavita`, kavita-client
/// `:650-674`): exact-match resolve per item, single or batched delete.
/// Best-effort — the row is already gone.
fn kavita_delete_items(state: &AppState, items: &[(Option<String>, Option<String>)]) {
    if !is_enabled(&state.db) {
        return;
    }
    let kavita = match state.kavita.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let config = effective_config(&state.db, None, None);
    let mut client = KavitaClient::new(kavita.transport(), config);
    let mut sink = |_: String| {};
    let mut ids = std::collections::HashSet::new();
    for (title, series) in items {
        let detail = client.find_series_detail(
            series.as_deref().unwrap_or(""),
            title.as_deref().unwrap_or(""),
            None,
        );
        if let Some(detail) = detail {
            ids.insert(detail.id);
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    if ids.len() == 1 {
        client.delete_series(ids[0], &mut sink);
    } else if !ids.is_empty() {
        client.delete_multiple_series(&ids, &mut sink);
    }
}

/// Fire-and-forget Kavita re-scan (`scanSeriesForLibraryItem`,
/// kavita-client `:720-733`).
fn kavita_scan_for_item(state: &AppState, title: Option<&str>, series: Option<&str>) {
    if !is_enabled(&state.db) {
        return;
    }
    let kavita = match state.kavita.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let config = effective_config(&state.db, None, None);
    let mut client = KavitaClient::new(kavita.transport(), config);
    let mut sink = |_: String| {};
    let detail = client.find_series_detail(series.unwrap_or(""), title.unwrap_or(""), None);
    if let Some(detail) = detail {
        client.scan_series(detail.id, &mut sink);
    }
}

/// `library:setGalleryId` (`:920-955`): attach/detach with the uniqueness
/// guard; the rename is best-effort and never undoes the attach.
pub(crate) fn set_gallery_id_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let item_id = opt_i64(args, 0).unwrap_or(0);
    let gallery_arg = args.get(1).cloned().unwrap_or(Value::Null);
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, item_id))
        .map_err(CommandError::Thrown)?;
    let Some(item) = item else {
        return Ok(json!({ "success": false, "error": "That item no longer exists" }));
    };
    if gallery_arg.is_null() {
        let mut fields = vec![("galleryId".to_string(), FieldValue::Null)];
        for (k, v) in rename_for_gallery_id(state, &item, None, log)
            .as_object()
            .cloned()
            .unwrap_or_default()
        {
            fields.push((k, FieldValue::from_json(&v)));
        }
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::library_write::update_item_fields(conn, item_id, &fields)
                    .map(|_| ())
            })
            .map_err(CommandError::Thrown)?;
        log(LogRecord {
            level: "info",
            scope: "library".to_string(),
            message: "detached an nhentai id".to_string(),
            fields: json!({ "itemId": item_id, "was": item.get("galleryId") }),
        });
        return Ok(json!({ "success": true, "data": { "galleryId": null } }));
    }
    let id = gallery_arg.as_i64().unwrap_or(0);
    if id <= 0 {
        return Ok(
            json!({ "success": false, "error": "An nhentai id is a positive whole number" }),
        );
    }
    let taken = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_gallery_id(conn, id))
        .map_err(CommandError::Thrown)?;
    if let Some(taken) = taken {
        if taken.get("id").and_then(Value::as_i64) != Some(item_id) {
            let label = taken
                .get("customTitle")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| {
                    taken
                        .get("filePath")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            return Ok(json!({
                "success": false,
                "error": format!("Gallery {id} is already attached to \"{label}\"")
            }));
        }
    }
    let mut fields = vec![("galleryId".to_string(), FieldValue::Int(id))];
    for (k, v) in rename_for_gallery_id(state, &item, Some(id), log)
        .as_object()
        .cloned()
        .unwrap_or_default()
    {
        fields.push((k, FieldValue::from_json(&v)));
    }
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::library_write::update_item_fields(conn, item_id, &fields).map(|_| ())
        })
        .map_err(CommandError::Thrown)?;
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: "attached an nhentai id by hand".to_string(),
        fields: json!({ "itemId": item_id, "galleryId": id }),
    });
    Ok(json!({ "success": true, "data": { "galleryId": id } }))
}

/// Embed metadata into the file (best-effort for the caller): builds the
/// context from the row + overrides and dispatches by format.
fn embed_for_row(
    state: &AppState,
    item: &Value,
    item_path: &std::path::Path,
    over: FileMetadataOverrides,
) -> Result<(), String> {
    let format_str = item.get("format").and_then(Value::as_str).unwrap_or("pdf");
    let format = kopibon_core::metadata::context::Format::parse_format(format_str);
    let meta = meta_for_item(&state.db, item, "YesAndRightToLeft", over);
    kopibon_core::metadata::writers::apply_metadata(
        item_path,
        format,
        &meta,
        &SystemClock,
        file_mtime_secs(item_path),
    )
}

/// Cross-device move: rename, falling back to copy + best-effort unlink
/// (`:1931-1948`).
fn move_file(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(src);
    Ok(())
}

/// Prune the old parent when the move emptied it (`:1950-1961`,
/// best-effort).
fn prune_empty_parent(dir: &std::path::Path) {
    let is_empty = std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if is_empty {
        let _ = std::fs::remove_dir(dir);
    }
}

/// `library:updateMetadata` (`:1736-2004`): merge present keys into the
/// row, re-embed (non-fatal), move on artist/series change with the
/// cross-device fallback, regroup on series change, Kavita re-scan.
pub(crate) fn update_metadata_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = opt_i64(args, 0).unwrap_or(0);
    if state.library.is_conversion_locked(id) {
        return Ok(conversion_lock_error());
    }
    let metadata = args.get(1).cloned().unwrap_or(Value::Null);
    let root_arg = args.get(2).and_then(Value::as_str).unwrap_or("").trim();
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    let Some(item) = item else {
        return Ok(json!({ "success": false, "error": format!("Library item {id} not found") }));
    };
    let stored_root = library_root(&state.db);
    let resolved_root = if root_arg.is_empty() {
        stored_root.clone()
    } else {
        root_arg.to_string()
    };
    let item_path = kopibon_core::download::resolve_library_path(
        item.get("filePath").and_then(Value::as_str).unwrap_or(""),
        &resolved_root,
    );

    // Merge: only present keys win; seriesIndex coerces via Number().
    let merged = |key: &str, fallback: &Value| -> Value {
        match metadata.get(key) {
            None => fallback.clone(),
            Some(v) => v.clone(),
        }
    };
    let item_title = item.get("customTitle").cloned().unwrap_or(Value::Null);
    let item_tags = item.get("customTags").cloned().unwrap_or(Value::Null);
    let item_language = item.get("customLanguage").cloned().unwrap_or(Value::Null);
    let item_date = item.get("customDate").cloned().unwrap_or(Value::Null);
    let item_series = item.get("seriesName").cloned().unwrap_or(Value::Null);
    let item_artist = item.get("primaryArtist").cloned().unwrap_or(Value::Null);
    let item_publisher = item.get("publisher").cloned().unwrap_or(Value::Null);
    let item_description = item.get("description").cloned().unwrap_or(Value::Null);
    let new_title = merged("customTitle", &item_title);
    let new_tags = merged("customTags", &item_tags);
    let new_language = merged("customLanguage", &item_language);
    let new_date = merged("customDate", &item_date);
    let new_series = merged("seriesName", &item_series);
    let new_artist = merged("primaryArtist", &item_artist);
    let new_series_index: Value = match metadata.get("seriesIndex") {
        None => item.get("seriesIndex").cloned().unwrap_or(Value::Null),
        Some(Value::Null) => Value::Null,
        Some(v) => v.as_f64().map(|f| json!(f)).unwrap_or(Value::Null),
    };
    let new_publisher = merged("publisher", &item_publisher);
    let new_description = merged("description", &item_description);

    let now_ms = SystemClock.now_ms();
    let mut fields: Vec<(String, FieldValue)> = vec![
        ("customTitle".to_string(), FieldValue::from_json(&new_title)),
        ("customTags".to_string(), FieldValue::from_json(&new_tags)),
        (
            "customLanguage".to_string(),
            FieldValue::from_json(&new_language),
        ),
        ("customDate".to_string(), FieldValue::from_json(&new_date)),
        ("seriesName".to_string(), FieldValue::from_json(&new_series)),
        (
            "primaryArtist".to_string(),
            FieldValue::from_json(&new_artist),
        ),
        ("updatedAt".to_string(), FieldValue::Int(now_ms)),
    ];
    if metadata.get("seriesIndex").is_some() {
        fields.push((
            "seriesIndex".to_string(),
            FieldValue::from_json(&new_series_index),
        ));
    }
    if metadata.get("publisher").is_some() {
        fields.push((
            "publisher".to_string(),
            FieldValue::from_json(&new_publisher),
        ));
    }
    if metadata.get("description").is_some() {
        fields.push((
            "description".to_string(),
            FieldValue::from_json(&new_description),
        ));
    }
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::library_write::update_item_fields(conn, id, &fields).map(|_| ())
        })
        .map_err(CommandError::Thrown)?;

    // Re-embed: the edited fields win, everything else comes from the
    // cached gallery via meta_for_item — never hand-built.
    let tag_list: Vec<String> = {
        let mut tags: Vec<String> = opts(&new_tags)
            .unwrap_or("")
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if let Some(artist) = opts(&new_artist).filter(|s| !s.is_empty()) {
            tags.push(artist.to_string());
        }
        tags
    };
    let edited_date_ms: Option<i64> = opts(&new_date).and_then(parse_date_ms);
    let mut over = FileMetadataOverrides {
        title: Some(
            opts(&new_title)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let gid = item.get("galleryId").and_then(Value::as_i64).unwrap_or(id);
                    format!("Gallery #{gid}")
                }),
        ),
        artists: Some(
            opts(&new_artist)
                .filter(|s| !s.is_empty())
                .map(|s| vec![s.to_string()])
                .unwrap_or_else(|| {
                    item.get("primaryArtist")
                        .and_then(Value::as_str)
                        .map(|s| vec![s.to_string()])
                        .unwrap_or_default()
                }),
        ),
        tags: Some(tag_list.clone()),
        all_tags: Some(tag_list),
        series_name: opts(&new_series).map(|s| s.to_string()).or_else(|| {
            item.get("seriesName")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        }),
        series_index: optf(&new_series_index)
            .or_else(|| item.get("seriesIndex").and_then(Value::as_f64)),
        language: opts(&new_language)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                item.get("language")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            }),
        publisher: opts(&new_publisher)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                item.get("publisher")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            }),
        description: opts(&new_description)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                item.get("description")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            }),
        ..Default::default()
    };
    if let Some(ms) = edited_date_ms {
        over.release_date = Some(kopibon_core::metadata::context::JsDate(ms));
    }
    if let Err(e) = embed_for_row(state, &item, &item_path, over) {
        log(LogRecord {
            level: "error",
            scope: "library".to_string(),
            message: "Failed to re-embed metadata".to_string(),
            fields: json!({ "err": e }),
        });
    }

    // Move on artist/series change (:1888-1969).
    let old_artist = item
        .get("primaryArtist")
        .and_then(Value::as_str)
        .unwrap_or("");
    let old_series = item.get("seriesName").and_then(Value::as_str);
    let new_artist_str = opts(&new_artist).unwrap_or("");
    let new_series_str = opts(&new_series);
    let artist_changed = !new_artist_str.is_empty() && new_artist_str != old_artist;
    let series_changed = new_series_str != old_series;
    // Root derivation when the caller passed none (:1889-1898). Uses the
    // PRE-move artist (item.primaryArtist), like 1.x.
    let derived_root = if root_arg.is_empty() {
        item_path
            .parent()
            .and_then(|parent| {
                let grandparent = parent.parent()?;
                if parent.file_name().and_then(|n| n.to_str()) == Some(old_artist) {
                    grandparent.to_str()
                } else {
                    grandparent.parent()?.to_str()
                }
            })
            .unwrap_or("")
            .to_string()
    } else {
        root_arg.to_string()
    };
    let mut new_path: Option<std::path::PathBuf> = None;
    if artist_changed || series_changed {
        let file_name = item_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let target_artist_dir = std::path::Path::new(&derived_root).join(new_artist_str);
        let target_dir = match new_series_str.filter(|s| !s.is_empty()) {
            Some(series) => target_artist_dir.join(series),
            None => target_artist_dir.clone(),
        };
        let _ = std::fs::create_dir_all(&target_artist_dir);
        if new_series_str.is_some() {
            let _ = std::fs::create_dir_all(&target_dir);
        }
        let candidate = target_dir.join(file_name);
        if candidate != item_path {
            let old_parent = item_path.parent().map(|p| p.to_path_buf());
            match move_file(&item_path, &candidate) {
                Ok(()) => {
                    if let Some(parent) = old_parent {
                        prune_empty_parent(&parent);
                    }
                    new_path = Some(candidate);
                }
                Err(e) => {
                    log(LogRecord {
                        level: "error",
                        scope: "library".to_string(),
                        message: "Failed to move file".to_string(),
                        fields: json!({ "err": e }),
                    });
                }
            }
        }
        if let Some(ref moved) = new_path {
            let rel = kopibon_core::download::relativize_library_path(moved, &resolved_root);
            let _ = state.db.with_writer(|conn| {
                kopibon_core::db::library_write::update_item_fields(
                    conn,
                    id,
                    &[("filePath".to_string(), FieldValue::Text(rel))],
                )
                .map(|_| ())
            });
        }
    }

    if series_changed {
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::series::resolve_for(conn, &[id], now_ms / 1000).map(|_| ())
        });
    }

    let updated = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .ok()
        .flatten();
    if let Some(updated) = updated {
        kavita_scan_for_item(
            state,
            updated.get("customTitle").and_then(Value::as_str),
            updated.get("seriesName").and_then(Value::as_str),
        );
    }

    let stored_file_path = item.get("filePath").and_then(Value::as_str).unwrap_or("");
    Ok(json!({
        "success": true,
        "data": {
            "newPath": new_path.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| stored_file_path.to_string()),
        },
    }))
}

/// `Value` as `Option<&str>` (merged metadata fields).
fn opts(v: &Value) -> Option<&str> {
    v.as_str()
}

/// `Value` as `Option<f64>`.
fn optf(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Parse a date string to ms (`new Date(s)` + finite check, `:1847`).
/// Accepts `YYYY-MM-DD` (UTC midnight, the metadata-dialog shape) and full
/// RFC 3339 timestamps; anything else → None (no releaseDate override).
fn parse_date_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Some(date) = s.get(..10) {
        let parts: Vec<&str> = date.split('-').collect();
        if parts.len() == 3 {
            if let (Ok(y), Ok(m), Ok(d)) = (
                parts[0].parse::<i64>(),
                parts[1].parse::<i64>(),
                parts[2].parse::<i64>(),
            ) {
                if (1..=12).contains(&m) && (1..=31).contains(&d) {
                    let days = days_from_civil(y, m as u32, d as u32);
                    return Some(days * 86_400_000);
                }
            }
        }
    }
    None
}

/// Howard Hinnant's days-from-civil: days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Delete one row by id, returning its (title, series) for the Kavita hook.
fn delete_row(state: &AppState, id: i64) -> Option<(Option<String>, Option<String>)> {
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .ok()
        .flatten()?;
    let _ = state
        .db
        .with_writer(|conn| kopibon_core::db::library_write::delete_item(conn, id).map(|_| ()));
    Some((
        item.get("customTitle")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        item.get("seriesName")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
    ))
}

/// `library:delete` (`:1606-1629`): guard, drop the row, fan the event out
/// to every window, optional Kavita delete.
pub(crate) fn delete_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    use tauri::Emitter;
    let id = opt_i64(args, 0).unwrap_or(0);
    if state.library.is_conversion_locked(id) {
        return Ok(conversion_lock_error());
    }
    let also_from_kavita = args.get(1).and_then(Value::as_bool).unwrap_or(false);
    let gallery_id = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .ok()
        .flatten()
        .and_then(|row| row.get("galleryId").and_then(Value::as_i64));
    let removed = delete_row(state, id);
    let _ = app.emit(
        "library:itemDeleted",
        json!({ "id": id, "galleryId": gallery_id }),
    );
    if also_from_kavita {
        if let Some((title, series)) = removed {
            kavita_delete_items(state, &[(title, series)]);
        }
    }
    Ok(json!({ "success": true }))
}

/// Shared file-delete: best-effort unlink with the missing-file warn.
fn unlink_item_file(state: &AppState, item: &Value, id: i64, log: &mut LogSink, warn_scope: &str) {
    let root = library_root(&state.db);
    let stored = item.get("filePath").and_then(Value::as_str).unwrap_or("");
    let path = kopibon_core::download::resolve_library_path(stored, &root);
    if !stored.is_empty() && path.exists() {
        let _ = std::fs::remove_file(&path);
    } else {
        log(LogRecord {
            level: "warn",
            scope: "library".to_string(),
            message: format!("{warn_scope}: file not found"),
            fields: json!({ "id": id, "stored": stored }),
        });
    }
}

/// `library:deleteFile` (`:1631-1656`): unlink (best-effort), drop the row,
/// always drop from Kavita.
pub(crate) fn delete_file_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
    _app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    let id = opt_i64(args, 0).unwrap_or(0);
    if state.library.is_conversion_locked(id) {
        return Ok(conversion_lock_error());
    }
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
        .map_err(CommandError::Thrown)?;
    if let Some(ref item) = item {
        unlink_item_file(state, item, id, log, "deleteFile");
    }
    let removed = delete_row(state, id);
    if let Some((title, series)) = removed {
        kavita_delete_items(state, &[(title, series)]);
    }
    Ok(json!({ "success": true }))
}

/// `library:deleteMultiple` (`:1658-1679`) + `deleteFileMultiple`
/// (`:1681-1713`): locked rows are skipped, events fan out per row, one
/// batched Kavita delete at the end (files variant always; rows variant
/// only with the flag).
pub(crate) fn delete_multiple_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
    app: &tauri::AppHandle,
    with_files: bool,
) -> Result<Value, CommandError> {
    use tauri::Emitter;
    let ids: Vec<i64> = args
        .first()
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let also_from_kavita = args.get(1).and_then(Value::as_bool).unwrap_or(false);
    let mut removed: Vec<(Option<String>, Option<String>)> = Vec::new();
    for id in ids {
        if state.library.is_conversion_locked(id) {
            continue;
        }
        let item = state
            .db
            .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, id))
            .ok()
            .flatten();
        let gallery_id = item
            .as_ref()
            .and_then(|row| row.get("galleryId").and_then(Value::as_i64));
        if with_files {
            if let Some(ref item) = item {
                unlink_item_file(state, item, id, log, "deleteFileMultiple");
            }
        }
        let pair = delete_row(state, id);
        if pair.is_some() {
            if let Some((title, series)) = pair {
                removed.push((title, series));
            }
            let _ = app.emit(
                "library:itemDeleted",
                json!({ "id": id, "galleryId": gallery_id }),
            );
        }
    }
    if (with_files || also_from_kavita) && !removed.is_empty() {
        kavita_delete_items(state, &removed);
    }
    Ok(json!({ "success": true }))
}

/// `library:assignSeries` (`:1140-1257`): embed + move into the series
/// subdir per entry (failures collected), one regroup, Kavita re-scan.
pub(crate) fn assign_series_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let entries: Vec<Value> = args
        .first()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let series_name = opt_str(args, 1).unwrap_or_default();
    let mut errors: Vec<String> = Vec::new();
    let mut assigned: Vec<i64> = Vec::new();
    let mut updated = 0i64;
    for entry in &entries {
        let entry_id = entry.get("id").and_then(Value::as_i64).unwrap_or(0);
        let item = state
            .db
            .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, entry_id))
            .ok()
            .flatten();
        let Some(item) = item else {
            errors.push(format!("Item {entry_id} not found"));
            continue;
        };
        if state.library.is_conversion_locked(entry_id) {
            errors.push(format!("Item {entry_id} is being converted to CBZ"));
            continue;
        }
        let volume: Option<f64> = entry
            .get("seriesIndex")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite());
        let root = library_root(&state.db);
        let item_path = kopibon_core::download::resolve_library_path(
            item.get("filePath").and_then(Value::as_str).unwrap_or(""),
            &root,
        );
        let over = FileMetadataOverrides {
            series_name: Some(series_name.clone()),
            series_index: volume,
            ..default_overrides(&state.db, &item)
        };
        if let Err(e) = embed_for_row(state, &item, &item_path, over) {
            let fmt = item.get("format").and_then(Value::as_str).unwrap_or("PDF");
            errors.push(format!(
                "Failed to embed series in {fmt} for item {entry_id}: {e}"
            ));
        }
        let mut db_update: Vec<(String, FieldValue)> = vec![
            (
                "seriesName".to_string(),
                FieldValue::Text(series_name.clone()),
            ),
            (
                "seriesIndex".to_string(),
                volume.map(FieldValue::Real).unwrap_or(FieldValue::Null),
            ),
        ];
        let current_dir = item_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let file_name = item_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let parent_name = current_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let primary_artist = item
            .get("primaryArtist")
            .and_then(Value::as_str)
            .unwrap_or("");
        let has_series = item.get("seriesName").and_then(Value::as_str).is_some();
        if parent_name == primary_artist || !has_series {
            let series_dir = current_dir.join(&series_name);
            let _ = std::fs::create_dir_all(&series_dir);
            let new_path = series_dir.join(file_name);
            match move_file(&item_path, &new_path) {
                Ok(()) => {
                    db_update.push((
                        "filePath".to_string(),
                        FieldValue::Text(kopibon_core::download::relativize_library_path(
                            &new_path, &root,
                        )),
                    ));
                }
                Err(e) => {
                    errors.push(format!("Failed to move file for item {entry_id}: {e}"));
                }
            }
        }
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::library_write::update_item_fields(conn, entry_id, &db_update)
                .map(|_| ())
        });
        assigned.push(entry_id);
        updated += 1;
    }
    if !assigned.is_empty() {
        let now_s = SystemClock.now_ms() / 1000;
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::series::resolve_for(conn, &assigned, now_s).map(|_| ())
        });
    }
    if !series_name.is_empty() {
        kavita_scan_for_item(state, None, Some(&series_name));
    }
    let mut data = json!({ "updated": updated });
    if !errors.is_empty() {
        data["errors"] = json!(errors);
    }
    Ok(json!({ "success": true, "data": data }))
}

/// `library:renameSeries` (`:697-801`): guards, per-member embed + move,
/// renameRow, regroup, log. Kavita block stays disabled (F5).
pub(crate) fn rename_series_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_id = opt_i64(args, 0).unwrap_or(0);
    let trimmed = opt_str(args, 1).unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        return Ok(json!({ "success": false, "error": "A series needs a name" }));
    }
    let group = state
        .db
        .with_reader(|conn| kopibon_core::db::series::find_by_id(conn, series_id))
        .map_err(CommandError::Thrown)?;
    let Some(group) = group else {
        return Ok(json!({ "success": false, "error": "That series no longer exists" }));
    };
    if trimmed == group.name {
        return Ok(json!({ "success": true, "data": { "renamed": 0 } }));
    }
    let clash = state
        .db
        .with_reader(|conn| kopibon_core::db::series::find_by_name(conn, &trimmed))
        .map_err(CommandError::Thrown)?
        .filter(|row| row.id != series_id);
    if let Some(clash) = clash {
        return Ok(json!({
            "success": false,
            "error": format!(
                "Another series is already called \"{}\". Rename that one first, or assign these galleries to it instead.",
                clash.name
            )
        }));
    }
    let mut empty = FilterOwned::default();
    let empty_filter = filter_params(&Value::Null, &mut empty);
    let member_ids =
        kopibon_core::db::library::matching_member_ids(&state.db, series_id, &empty_filter)
            .map_err(CommandError::Thrown)?;
    let mut errors: Vec<String> = Vec::new();
    let mut renamed = 0i64;
    let root = library_root(&state.db);
    for member_id in &member_ids {
        let item = state
            .db
            .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, *member_id))
            .ok()
            .flatten();
        let Some(item) = item else { continue };
        let item_path = kopibon_core::download::resolve_library_path(
            item.get("filePath").and_then(Value::as_str).unwrap_or(""),
            &root,
        );
        if state
            .library
            .is_conversion_locked(item.get("id").and_then(Value::as_i64).unwrap_or(0))
        {
            errors.push(format!(
                "{} is being converted",
                item_path.file_name().and_then(|n| n.to_str()).unwrap_or("")
            ));
            continue;
        }
        let over = FileMetadataOverrides {
            series_name: Some(trimmed.clone()),
            ..default_overrides(&state.db, &item)
        };
        if let Err(e) = embed_for_row(state, &item, &item_path, over) {
            errors.push(format!(
                "Could not update metadata for {}: {e}",
                item_path.file_name().and_then(|n| n.to_str()).unwrap_or("")
            ));
        }
        let mut update = vec![("seriesName".to_string(), FieldValue::Text(trimmed.clone()))];
        if let Some(current_dir) = item_path.parent() {
            if current_dir.file_name().and_then(|n| n.to_str()) == Some(group.name.as_str()) {
                let target_dir = current_dir
                    .parent()
                    .map(|p| p.join(&trimmed))
                    .unwrap_or_else(|| std::path::PathBuf::from(&trimmed));
                let target_path =
                    target_dir.join(item_path.file_name().and_then(|n| n.to_str()).unwrap_or(""));
                if target_path.exists() {
                    errors.push(format!(
                        "{} already exists in the new folder",
                        target_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                    ));
                } else {
                    let _ = std::fs::create_dir_all(&target_dir);
                    match move_file(&item_path, &target_path) {
                        Ok(()) => {
                            update.push((
                                "filePath".to_string(),
                                FieldValue::Text(kopibon_core::download::relativize_library_path(
                                    &target_path,
                                    &root,
                                )),
                            ));
                        }
                        Err(e) => {
                            errors.push(format!(
                                "Could not move {}: {e}",
                                item_path.file_name().and_then(|n| n.to_str()).unwrap_or("")
                            ));
                        }
                    }
                }
            }
        }
        let item_id = item.get("id").and_then(Value::as_i64).unwrap_or(0);
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::library_write::update_item_fields(conn, item_id, &update).map(|_| ())
        });
        renamed += 1;
    }
    let now_ms = SystemClock.now_ms();
    let _ = state.db.with_writer(|conn| {
        kopibon_core::db::library_write::series_rename_row(conn, series_id, &trimmed, now_ms)
            .map(|_| ())
    });
    let now_s = now_ms / 1000;
    let _ = state.db.with_writer(|conn| {
        kopibon_core::db::series::resolve_for(conn, &member_ids, now_s).map(|_| ())
    });
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: "renamed a series".to_string(),
        fields: json!({ "from": group.name, "to": trimmed, "members": renamed }),
    });
    let mut data = json!({ "renamed": renamed });
    if !errors.is_empty() {
        data["errors"] = json!(errors);
    }
    Ok(json!({ "success": true, "data": data }))
}

/// `library:setSeriesDissolved` (`:809-813`) + `setSeriesCover` (`:816-819`)
/// + `previewSeriesGrouping` (`:651-653`) + `setSeriesGrouping` (`:666-683`).
pub(crate) fn set_series_dissolved_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_id = opt_i64(args, 0).unwrap_or(0);
    let dissolved = args.get(1).and_then(Value::as_bool).unwrap_or(false);
    let now_ms = SystemClock.now_ms();
    let affected = state
        .db
        .with_writer(|conn| {
            kopibon_core::db::library_write::series_set_dissolved(
                conn, series_id, dissolved, now_ms,
            )
        })
        .map_err(CommandError::Thrown)?;
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: if dissolved {
            "dissolved a series"
        } else {
            "regrouped a series"
        }
        .to_string(),
        fields: json!({ "seriesId": series_id, "affected": affected }),
    });
    Ok(json!({ "success": true, "data": { "affected": affected } }))
}

pub(crate) fn set_series_cover_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let series_id = opt_i64(args, 0).unwrap_or(0);
    let item_id = args.get(1).and_then(Value::as_i64);
    let now_ms = SystemClock.now_ms();
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::library_write::series_set_cover(
                conn, series_id, item_id, None, now_ms,
            )
            .map(|_| ())
        })
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true }))
}

pub(crate) fn preview_series_grouping_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let preview = state
        .db
        .with_reader(|conn| {
            kopibon_core::db::series::preview_backfill(
                conn,
                kopibon_core::series_grouping::DEFAULT_MIN_SERIES_MEMBERS,
            )
        })
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": preview }))
}

pub(crate) fn set_series_grouping_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let enabled = args.first().and_then(Value::as_bool).unwrap_or(false);
    state
        .db
        .with_writer(|conn| {
            kopibon_core::db::settings::set(
                conn,
                "seriesGrouping",
                if enabled { "true" } else { "false" },
            )
            .map(|_| ())
        })
        .map_err(CommandError::Thrown)?;
    if !enabled {
        log(LogRecord {
            level: "info",
            scope: "library".to_string(),
            message: "series grouping disabled".to_string(),
            fields: json!({}),
        });
        return Ok(json!({ "success": true, "data": { "groups": 0, "galleries": 0 } }));
    }
    let now_s = SystemClock.now_ms() / 1000;
    let result = state
        .db
        .with_writer(|conn| kopibon_core::db::series::backfill_all(conn, now_s))
        .map_err(CommandError::Thrown)?;
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: "series grouping enabled".to_string(),
        fields: json!({ "linked": result.linked, "visibleGroups": result.visible_groups }),
    });
    let preview = state
        .db
        .with_reader(|conn| {
            kopibon_core::db::series::preview_backfill(
                conn,
                kopibon_core::series_grouping::DEFAULT_MIN_SERIES_MEMBERS,
            )
        })
        .map_err(CommandError::Thrown)?;
    Ok(json!({
        "success": true,
        "data": {
            "groups": result.visible_groups,
            "galleries": preview.get("galleries").and_then(Value::as_i64).unwrap_or(0),
        },
    }))
}

/// `library:reset` (`:1103-1111`).
pub(crate) fn reset_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state
        .db
        .with_writer(|conn| kopibon_core::db::library_write::reset_library(conn).map(|_| ()))
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true }))
}

/// `library:getConversionQueue` (`:3389-3403`): counts + outstanding +
/// recent errors (only when failed > 0).
pub(crate) fn get_conversion_queue_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let counts = state
        .db
        .with_reader(kopibon_core::db::conversion::counts)
        .map_err(CommandError::Thrown)?;
    let failed = counts.get("failed").and_then(Value::as_i64).unwrap_or(0);
    let errors = if failed > 0 {
        state
            .db
            .with_reader(|conn| kopibon_core::db::conversion::recent_errors(conn, 5))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let outstanding = counts.get("pending").and_then(Value::as_i64).unwrap_or(0)
        + counts
            .get("converting")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    Ok(json!({
        "success": true,
        "data": {
            "pending": counts.get("pending"),
            "converting": counts.get("converting"),
            "completed": counts.get("completed"),
            "failed": counts.get("failed"),
            "outstanding": outstanding,
            "errors": errors,
        },
    }))
}

/// `library:clearConversionQueue` (`:3405-3412`): wipe the table + drop the
/// UI lock sets.
pub(crate) fn clear_conversion_queue_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let cleared = state
        .db
        .with_writer(|conn| {
            conn.execute("DELETE FROM conversion_queue", [])
                .map_err(|e| e.to_string())
        })
        .map_err(CommandError::Thrown)? as i64;
    if let Ok(mut locks) = state.library.conversion_locks.lock() {
        locks.clear();
    }
    Ok(json!({ "success": true, "data": { "cleared": cleared } }))
}

/// `library:getSyncQueue` (`:2505-2515`): counts + outstanding + errors.
/// `library:clearSyncQueue` (`:2518-2520`).
pub(crate) fn get_sync_queue_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let counts = state
        .db
        .with_reader(kopibon_core::db::sync::counts)
        .map_err(CommandError::Thrown)?;
    let errors = state
        .db
        .with_reader(|conn| kopibon_core::db::sync::recent_errors(conn, 5))
        .unwrap_or_default();
    let outstanding = counts.get("pending").and_then(Value::as_i64).unwrap_or(0)
        + counts.get("syncing").and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({
        "success": true,
        "data": {
            "pending": counts.get("pending"),
            "syncing": counts.get("syncing"),
            "completed": counts.get("completed"),
            "failed": counts.get("failed"),
            "outstanding": outstanding,
            "errors": errors,
        },
    }))
}

pub(crate) fn clear_sync_queue_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let cleared = state
        .db
        .with_writer(|conn| kopibon_core::db::sync::clear_all(conn))
        .map_err(CommandError::Thrown)? as i64;
    Ok(json!({ "success": true, "data": { "cleared": cleared } }))
}

/// `library:getDefaultPaths` (`:3551-3559`).
pub(crate) fn get_default_paths_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    Ok(json!({
        "success": true,
        "data": {
            "thumbnailPath": crate::library::thumbnail_dir(&state.data_dir, &state.db)
                .to_string_lossy()
                .to_string(),
            "originalsPath": crate::library::originals_root(&state.db),
        },
    }))
}

/// Cached originals summary (`:3447-3482`): fresh cache wins, else walk and
/// store. One walk at a time is a renderer-side concern here — commands run
/// on the pool, and two concurrent walks just waste one walk.
fn originals_info_cached(state: &AppState, root: &str) -> Value {
    if let Ok(guard) = state.library.originals_cache.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.root == root && SystemClock.now_ms() - entry.at_ms < 60_000 {
                return entry.info.clone();
            }
        }
    }
    let info =
        crate::library::originals_info(&crate::library::walk_originals(std::path::Path::new(root)));
    if let Ok(mut guard) = state.library.originals_cache.lock() {
        *guard = Some(crate::library::OriginalsCacheEntry {
            root: root.to_string(),
            at_ms: SystemClock.now_ms(),
            info: info.clone(),
        });
    }
    info
}

/// `library:getOriginalsInfo` (`:3561-3570`): zeros when the root is
/// missing.
pub(crate) fn get_originals_info_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let root = crate::library::originals_root(&state.db);
    if root.is_empty() || !std::path::Path::new(&root).exists() {
        return Ok(json!({
            "success": true,
            "data": { "count": 0, "bytes": 0, "lossyCount": 0, "lossyBytes": 0 },
        }));
    }
    Ok(json!({ "success": true, "data": originals_info_cached(state, &root) }))
}

/// `library:restoreOriginals` (`:3595-3690`): the safety order is the
/// contract — never overwrite, move then confirm, only then delete the
/// CBZ, then the row.
pub(crate) fn restore_originals_impl(
    state: &AppState,
    _args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let archive_root = crate::library::originals_root(&state.db);
    let library_root_str = library_root(&state.db);
    if archive_root.is_empty()
        || !std::path::Path::new(&archive_root).exists()
        || library_root_str.is_empty()
    {
        return Ok(
            json!({ "success": true, "data": { "restored": 0, "skipped": 0, "failed": 0, "bytes": 0 } }),
        );
    }
    let archive_path = std::path::Path::new(&archive_root);
    let files = crate::library::walk_originals(archive_path);
    let mut archived: Vec<&crate::library::OriginalFile> = files.iter().collect();
    archived.sort_by(|a, b| {
        let al = a.lossy as u8;
        let bl = b.lossy as u8;
        al.cmp(&bl).then(a.path.cmp(&b.path))
    });
    let (mut restored, mut skipped, mut failed, mut bytes) = (0i64, 0i64, 0i64, 0i64);
    for file in archived {
        let rel = file.path.strip_prefix(archive_path).unwrap_or(&file.path);
        let mut parts: Vec<String> = rel
            .components()
            .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if parts.first().map(|s| s.as_str()) == Some("_lossy") {
            parts.remove(0);
        }
        if parts.is_empty() {
            skipped += 1;
            continue;
        }
        let mut target_pdf = std::path::PathBuf::from(&library_root_str);
        for part in &parts {
            target_pdf.push(part);
        }
        // The CBZ next to it: trailing `.pdf` → `.cbz`, anything else left
        // alone (`targetPdf.replace(/\.pdf$/i, '.cbz')`) — including the
        // degenerate case where that names the restored file itself.
        let target_cbz = target_pdf
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| {
                if n.to_lowercase().ends_with(".pdf") {
                    target_pdf.with_extension("cbz")
                } else {
                    target_pdf.clone()
                }
            })
            .unwrap_or_else(|| target_pdf.clone());
        if target_pdf.exists() {
            skipped += 1;
            continue;
        }
        if let Some(parent) = target_pdf.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(&file.path, &target_pdf).is_err() {
            failed += 1;
            continue;
        }
        if !target_pdf.exists() {
            failed += 1;
            continue;
        }
        let cbz_rel =
            kopibon_core::download::relativize_library_path(&target_cbz, &library_root_str);
        let row = state
            .db
            .with_reader(|conn| {
                kopibon_core::db::library_write::find_item_by_file_path(conn, &cbz_rel)
            })
            .ok()
            .flatten();
        if target_cbz.exists() {
            let _ = std::fs::remove_file(&target_cbz);
        }
        if let Some(row) = row {
            let row_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
            let moved = rename_thumbnail_for_path(
                &state.data_dir,
                &state.db,
                row.get("customCoverPath").and_then(Value::as_str),
                &target_pdf.to_string_lossy(),
            );
            let mtime = file_mtime_secs(&target_pdf) as i64 * 1000;
            let mut fields = vec![
                (
                    "filePath".to_string(),
                    FieldValue::Text(kopibon_core::download::relativize_library_path(
                        &target_pdf,
                        &library_root_str,
                    )),
                ),
                ("format".to_string(), FieldValue::Text("pdf".to_string())),
                ("fileSize".to_string(), FieldValue::Int(file.size)),
                ("fileMtime".to_string(), FieldValue::Int(mtime)),
                (
                    "updatedAt".to_string(),
                    FieldValue::Int(SystemClock.now_ms()),
                ),
            ];
            if let Some(moved) = moved {
                fields.push((
                    "customCoverPath".to_string(),
                    FieldValue::Text(moved.clone()),
                ));
                fields.push(("thumbnailPath".to_string(), FieldValue::Text(moved)));
            }
            let _ = state.db.with_writer(|conn| {
                kopibon_core::db::library_write::update_item_fields(conn, row_id, &fields)
                    .map(|_| ())
            });
        }
        restored += 1;
        bytes += file.size;
    }
    state.library.invalidate_originals_info();
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: format!("Restored {restored} original PDF(s); {skipped} skipped, {failed} failed"),
        fields: json!({}),
    });
    Ok(
        json!({ "success": true, "data": { "restored": restored, "skipped": skipped, "failed": failed, "bytes": bytes } }),
    )
}

/// `library:purgeOriginals` (`:3692-3767`): delete (lossy only with the
/// flag), prune empties, invalidate.
pub(crate) fn purge_originals_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let include_lossy = args.first().and_then(Value::as_bool).unwrap_or(false);
    let root = crate::library::originals_root(&state.db);
    if root.is_empty() || !std::path::Path::new(&root).exists() {
        return Ok(json!({ "success": true, "data": { "deleted": 0, "bytes": 0, "failed": 0 } }));
    }
    let files = crate::library::walk_originals(std::path::Path::new(&root));
    let (mut deleted, mut bytes, mut failed) = (0i64, 0i64, 0i64);
    for file in &files {
        if file.lossy && !include_lossy {
            continue;
        }
        match std::fs::remove_file(&file.path) {
            Ok(()) => {
                deleted += 1;
                bytes += file.size;
            }
            Err(_) => failed += 1,
        }
    }
    let mut removed_dirs = 0i64;
    fn prune(dir: &std::path::Path, removed_dirs: &mut i64) -> bool {
        let entries: Vec<_> = std::fs::read_dir(dir)
            .map(|e| e.flatten().collect())
            .unwrap_or_default();
        let mut remaining = 0;
        for entry in &entries {
            if entry.path().is_dir() {
                if !prune(&entry.path(), removed_dirs) {
                    remaining += 1;
                }
            } else {
                remaining += 1;
            }
        }
        if remaining > 0 {
            return false;
        }
        if std::fs::remove_dir(dir).is_ok() {
            *removed_dirs += 1;
            true
        } else {
            false
        }
    }
    prune(std::path::Path::new(&root), &mut removed_dirs);
    state.library.invalidate_originals_info();
    Ok(json!({
        "success": true,
        "data": { "deleted": deleted, "bytes": bytes, "failed": failed, "removedDirs": removed_dirs },
    }))
}

/// Image extensions `addCustom` accepts (`:1363-1365` — no avif, unlike
/// preview).
fn is_add_custom_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["jpg", "jpeg", "png", "webp", "gif", "bmp"]
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Natural-sorted image files in a folder (full paths).
fn image_files_sorted(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| {
                    e.file_name()
                        .to_str()
                        .filter(|n| is_add_custom_image(n))
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    crate::library::sort_natural(names)
        .into_iter()
        .map(|n| dir.join(n))
        .collect()
}

/// Re-encode pages to JPEG (`cbz-generator.ts:65-100`): maxDimension
/// inside-fit without enlargement, then JPEG quality (default 80).
/// Progress per page; returns the JPEG bytes in order.
fn transform_pages(
    image_files: &[std::path::PathBuf],
    quality: Option<i64>,
    max_dimension: Option<u32>,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<Vec<Vec<u8>>, String> {
    let q = quality.unwrap_or(80).clamp(1, 100) as u8;
    let mut out = Vec::with_capacity(image_files.len());
    for (i, path) in image_files.iter().enumerate() {
        let img = image::open(path).map_err(|e| e.to_string())?;
        let resized = match max_dimension {
            Some(cap) if img.width() > cap || img.height() > cap => img.thumbnail(cap, cap),
            _ => img,
        };
        let mut buf = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q);
        encoder.encode_image(&resized).map_err(|e| e.to_string())?;
        out.push(buf);
        progress(i + 1, image_files.len());
    }
    Ok(out)
}

/// Write the CBZ (`cbz-generator.ts:103-132`): ComicInfo.xml first
/// (uncompressed), then `%04d.<ext>` entries STORED. Atomic via part file.
fn write_cbz_archive(
    dest: &std::path::Path,
    ci_xml: &[u8],
    pages: &[(String, Vec<u8>)],
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), String> {
    use std::io::Write;
    let part = dest.with_extension("part");
    let file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("ComicInfo.xml", stored)
        .map_err(|e| e.to_string())?;
    zip.write_all(ci_xml).map_err(|e| e.to_string())?;
    for (i, (ext, bytes)) in pages.iter().enumerate() {
        zip.start_file(format!("{:04}.{ext}", i + 1), stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
        progress(i + 1, pages.len());
    }
    zip.finish().map_err(|e| e.to_string())?;
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Strip the 1.x filename poison set + 120-char cap + trim (`:1311-1314`).
fn safe_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>'].contains(c))
        .take(120)
        .collect::<String>()
        .trim()
        .to_string()
}

/// `library:addCustom` (`:1261-1602`): build a library file from images or
/// a PDF, embed metadata, thumbnail, insert + artists + regroup.
#[allow(clippy::too_many_lines)]
pub(crate) fn add_custom_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    use tauri::Emitter;
    let metadata = args.first().cloned().unwrap_or(Value::Null);
    let library_root_arg = opt_str(args, 1).unwrap_or_default();
    let get = |key: &str| metadata.get(key).cloned().unwrap_or(Value::Null);
    let get_str = |key: &str| {
        metadata
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let format = crate::library::resolve_output_format(
        metadata.get("format").and_then(Value::as_str),
        crate::auth::stored_setting(&state.db, "outputFormat").as_deref(),
    );
    let report = |phase: &str, current: i64, total: i64| {
        let _ = app.emit(
            "library:addCustomProgress",
            json!({ "phase": phase, "current": current, "total": total }),
        );
    };

    let artists: Vec<String> = metadata
        .get("artists")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let primary_artist = artists
        .first()
        .cloned()
        .unwrap_or_else(|| "Unknown".to_string());
    let artist_dir = std::path::Path::new(&library_root_arg).join(&primary_artist);
    std::fs::create_dir_all(&artist_dir).map_err(|e| CommandError::Thrown(e.to_string()))?;

    let title = get_str("title");
    let dest_path = artist_dir.join(format!("[nhentai-00000] {}.{format}", safe_title(&title)));
    let tag_list: Vec<String> = get_str("tags")
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let source_path = get_str("sourcePath");
    let source_type = get_str("sourceType");
    let compression = metadata.get("compression").cloned().unwrap_or(Value::Null);
    let compress = compression.get("enabled").and_then(Value::as_bool) == Some(true);

    let mut thumb_source: Option<String> = metadata
        .get("coverPath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let manga_direction = crate::auth::stored_setting(&state.db, "cbzMangaDirection")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "YesAndRightToLeft".to_string());
    let mut base_meta = kopibon_core::metadata::context::default_file_metadata();
    base_meta.title = title.clone();
    base_meta.artists = artists.clone();
    base_meta.tags = tag_list.clone();
    base_meta.all_tags = tag_list.clone();
    base_meta.description = metadata
        .get("description")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    base_meta.language = metadata
        .get("language")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let final_path: std::path::PathBuf;
    if format == "cbz" {
        base_meta.series_name = metadata
            .get("series")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        base_meta.format = Some("cbz".to_string());
        base_meta.manga_direction = manga_direction;
        let meta = kopibon_core::metadata::context::make_file_metadata(base_meta);

        let image_files: Vec<std::path::PathBuf> = if source_type == "images" {
            let files = image_files_sorted(std::path::Path::new(&source_path));
            if files.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "No image files found in selected folder" }),
                );
            }
            files
        } else {
            report("Extracting pages from the PDF", 0, 0);
            let scratch = state
                .data_dir
                .join("add-custom")
                .join(SystemClock.now_ms().to_string());
            std::fs::create_dir_all(&scratch).map_err(|e| CommandError::Thrown(e.to_string()))?;
            let result = kopibon_core::conversion::extract::extract_pdf_images(
                std::path::Path::new(&source_path),
                &scratch,
                &mut |_: String| {},
            );
            let _ = std::fs::remove_dir_all(&scratch);
            result.map_err(CommandError::Thrown)?.image_paths
        };
        if thumb_source.is_none() {
            if let Some(first) = image_files.first() {
                thumb_source = first.to_str().map(|s| s.to_string());
            }
        }
        let ci_xml = kopibon_core::metadata::writers::comicinfo::comicinfo_for_archive(
            &meta,
            image_files.len(),
        )
        .map_err(CommandError::Thrown)?;
        if compress {
            let quality = compression.get("quality").and_then(Value::as_i64);
            let max_dim = compression
                .get("maxDimension")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let mut on_progress = |current: usize, total: usize| {
                report("Compressing pages", current as i64, total as i64);
            };
            let pages = transform_pages(&image_files, quality, max_dim, &mut on_progress)
                .map_err(CommandError::Thrown)?;
            // Progress already reported per page during transform; the write
            // pass reports nothing extra (cbz-generator.ts:125-127).
            let owned: Vec<(String, Vec<u8>)> =
                pages.into_iter().map(|b| ("jpg".to_string(), b)).collect();
            let mut silent = |_: usize, _: usize| {};
            write_cbz_archive(&dest_path, &ci_xml, &owned, &mut silent)
                .map_err(CommandError::Thrown)?;
        } else {
            let mut owned: Vec<(String, Vec<u8>)> = Vec::with_capacity(image_files.len());
            for path in &image_files {
                let bytes = std::fs::read(path).map_err(|e| CommandError::Thrown(e.to_string()))?;
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("jpg")
                    .to_lowercase();
                owned.push((ext, bytes));
            }
            let mut on_progress = |current: usize, total: usize| {
                report("Building archive", current as i64, total as i64);
            };
            write_cbz_archive(&dest_path, &ci_xml, &owned, &mut on_progress)
                .map_err(CommandError::Thrown)?;
        }
        final_path = dest_path;
    } else {
        if source_type == "images" {
            let image_files = image_files_sorted(std::path::Path::new(&source_path));
            if image_files.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "No image files found in selected folder" }),
                );
            }
            if thumb_source.is_none() {
                thumb_source = image_files
                    .first()
                    .and_then(|p| p.to_str())
                    .map(|s| s.to_string());
            }
            let quality = if compress {
                compression
                    .get("quality")
                    .and_then(Value::as_i64)
                    .unwrap_or(100)
            } else {
                100
            };
            let options = kopibon_core::download::worker_pdf::PdfOptions {
                page_size: compression
                    .get("pageSize")
                    .and_then(Value::as_str)
                    .unwrap_or("fit")
                    .to_string(),
                quality,
                black_background: compression
                    .get("blackBackground")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            // `generate_pdf` reports through its log tap, not per-page
            // progress — the phase report above stands in.
            kopibon_core::download::worker_pdf::generate_pdf(
                &image_files,
                &dest_path,
                &options,
                &mut |_: String| {},
            )
            .map_err(CommandError::Thrown)?;
        } else {
            std::fs::copy(&source_path, &dest_path)
                .map_err(|e| CommandError::Thrown(e.to_string()))?;
        }
        final_path = dest_path;
        report("Writing metadata", 0, 0);
        base_meta.format = Some("pdf".to_string());
        base_meta.release_date = get("date")
            .as_str()
            .and_then(parse_date_ms)
            .map(kopibon_core::metadata::context::JsDate);
        let meta = kopibon_core::metadata::context::make_file_metadata(base_meta);
        kopibon_core::metadata::writers::apply_metadata(
            &final_path,
            kopibon_core::metadata::context::Format::Pdf,
            &meta,
            &SystemClock,
            file_mtime_secs(&final_path),
        )
        .map_err(CommandError::Thrown)?;
    }

    report("Creating the thumbnail", 0, 0);
    let mut generated_thumb: Option<String> = None;
    if thumb_source.is_none() && format == "pdf" {
        let scratch = state
            .data_dir
            .join("thumb-src")
            .join(SystemClock.now_ms().to_string());
        let _ = std::fs::create_dir_all(&scratch);
        let rendered = kopibon_core::conversion::raster::render_first_page(&final_path, None)
            .ok()
            .and_then(|img| {
                let dest = scratch.join("p.jpg");
                img.save(&dest).ok()?;
                Some(dest)
            });
        if let Some(rendered) = rendered {
            generated_thumb = crate::library::build_thumbnail_for(
                &state.data_dir,
                &state.db,
                &rendered,
                &final_path.to_string_lossy(),
            )
            .ok();
        }
        let _ = std::fs::remove_dir_all(&scratch);
    } else if let Some(source) = thumb_source.as_ref() {
        generated_thumb = crate::library::build_thumbnail_for(
            &state.data_dir,
            &state.db,
            std::path::Path::new(source),
            &final_path.to_string_lossy(),
        )
        .ok();
    }

    let file_size = std::fs::metadata(&final_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let now_ms = SystemClock.now_ms();
    let cover = cover_filename(generated_thumb.as_deref());
    let rel = kopibon_core::download::relativize_library_path(&final_path, &library_root_arg);
    let custom = kopibon_core::db::library_write::CustomInsert {
        gallery_id: None,
        is_custom: 1,
        custom_title: &title,
        custom_tags: metadata.get("tags").and_then(Value::as_str),
        custom_language: metadata.get("language").and_then(Value::as_str),
        custom_date: metadata.get("date").and_then(Value::as_str),
        custom_cover_path: cover.as_deref(),
        file_path: &rel,
        file_size,
        format: &format,
        primary_artist: &primary_artist,
        series_name: metadata.get("series").and_then(Value::as_str),
        description: metadata.get("description").and_then(Value::as_str),
        added_at_ms: now_ms,
    };
    let new_id = state
        .db
        .with_writer(|conn| kopibon_core::db::library_write::insert_custom(conn, &custom))
        .map_err(CommandError::Thrown)?;
    for (i, artist) in artists.iter().enumerate() {
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::library_write::add_artist(conn, new_id, artist, i as i64).map(|_| ())
        });
    }
    let _ = state.db.with_writer(|conn| {
        kopibon_core::db::series::resolve_for(conn, &[new_id], now_ms / 1000).map(|_| ())
    });
    Ok(json!({
        "success": true,
        "data": { "id": new_id, "filePath": final_path.to_string_lossy().to_string(), "format": format },
    }))
}

/// `library:previewSource` (`:3784-3881`): thumbnail data URI for an
/// add-custom candidate. Images: first natural-sorted page (avif allowed
/// here, unlike `addCustom`); PDF: pdfium-rendered first page — the
/// vendored-renderer replacement for the `pdftoppm` subprocess (D3).
pub(crate) fn preview_source_impl(
    _state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let source_path = opt_str(args, 0).unwrap_or_default();
    let source_type = opt_str(args, 1).unwrap_or_default();
    if source_type == "images" {
        let names: Vec<String> = std::fs::read_dir(&source_path)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().is_file())
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|n| {
                        let lower = n.to_lowercase();
                        [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]
                            .iter()
                            .any(|ext| lower.ends_with(ext))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let sorted = crate::library::sort_natural(names);
        let Some(first) = sorted.first() else {
            return Ok(json!({ "success": false, "error": "No images in folder" }));
        };
        let bytes = std::fs::read(std::path::Path::new(&source_path).join(first))
            .map_err(|e| CommandError::Thrown(e.to_string()))?;
        let uri =
            crate::library::jpeg_data_uri_thumb(&bytes, 360, 480).map_err(CommandError::Thrown)?;
        return Ok(json!({ "success": true, "data": uri }));
    }
    let rendered = kopibon_core::conversion::raster::render_first_page(
        std::path::Path::new(&source_path),
        None,
    )
    .map_err(CommandError::Thrown)?;
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 78);
    encoder
        .encode_image(&rendered)
        .map_err(|e| CommandError::Thrown(e.to_string()))?;
    let uri = crate::library::jpeg_data_uri_thumb(&buf, 360, 480).map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": uri }))
}

/// `library:deleteMultiple` rows variant.
pub(crate) fn delete_multiple_rows_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    delete_multiple_impl(state, args, log, app, false)
}

/// `library:deleteFileMultiple` files variant.
pub(crate) fn delete_multiple_files_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    delete_multiple_impl(state, args, log, app, true)
}

// ─── Wrappers ──────────────────────────────────────────────────────────

macro_rules! lib_mut {
    ($name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $name(state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
    ($name:ident, $channel:literal, $impl_fn:ident, app) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $name(
            app: tauri::AppHandle,
            state: State<AppState>,
            args: Vec<Value>,
        ) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log, &app));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

lib_mut!(
    library_set_gallery_id,
    "library:setGalleryId",
    set_gallery_id_impl
);
lib_mut!(
    library_update_metadata,
    "library:updateMetadata",
    update_metadata_impl
);
lib_mut!(
    library_add_custom,
    "library:addCustom",
    add_custom_impl,
    app
);
lib_mut!(
    library_assign_series,
    "library:assignSeries",
    assign_series_impl
);
lib_mut!(library_delete, "library:delete", delete_impl, app);
lib_mut!(
    library_delete_file,
    "library:deleteFile",
    delete_file_impl,
    app
);
lib_mut!(
    library_delete_multiple,
    "library:deleteMultiple",
    delete_multiple_rows_impl,
    app
);
lib_mut!(
    library_delete_file_multiple,
    "library:deleteFileMultiple",
    delete_multiple_files_impl,
    app
);
lib_mut!(
    library_rename_series,
    "library:renameSeries",
    rename_series_impl
);
lib_mut!(
    library_set_series_dissolved,
    "library:setSeriesDissolved",
    set_series_dissolved_impl
);
lib_mut!(
    library_set_series_cover,
    "library:setSeriesCover",
    set_series_cover_impl
);
lib_mut!(
    library_preview_series_grouping,
    "library:previewSeriesGrouping",
    preview_series_grouping_impl
);
lib_mut!(
    library_set_series_grouping,
    "library:setSeriesGrouping",
    set_series_grouping_impl
);
lib_mut!(library_reset, "library:reset", reset_impl);
lib_mut!(
    library_get_conversion_queue,
    "library:getConversionQueue",
    get_conversion_queue_impl
);
lib_mut!(
    library_clear_conversion_queue,
    "library:clearConversionQueue",
    clear_conversion_queue_impl
);
lib_mut!(
    library_get_sync_queue,
    "library:getSyncQueue",
    get_sync_queue_impl
);
lib_mut!(
    library_clear_sync_queue,
    "library:clearSyncQueue",
    clear_sync_queue_impl
);
lib_mut!(
    library_get_default_paths,
    "library:getDefaultPaths",
    get_default_paths_impl
);
lib_mut!(
    library_get_originals_info,
    "library:getOriginalsInfo",
    get_originals_info_impl
);
lib_mut!(
    library_restore_originals,
    "library:restoreOriginals",
    restore_originals_impl
);
lib_mut!(
    library_purge_originals,
    "library:purgeOriginals",
    purge_originals_impl
);
lib_mut!(
    library_preview_source,
    "library:previewSource",
    preview_source_impl
);
