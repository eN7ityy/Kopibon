//! `searchSettings:*` + `search:*` + `blocked:*` + `tags:*` (02-ipc-surface
//! §2.13–2.15, `search-settings.ipc.ts:117-317`).
//!
//! Search defaults live in `app_settings` as plain strings; the blocked
//! list has its own table (`db::blocked`); query composition and dim
//! matching are pure core fns (`nhentai::query`); tag resolution is
//! cache-first with network fallback (`nhentai::tags` over the shared
//! client + a DB reader — readers never block the writer, so holding the
//! reader across the fetch is safe).

use kopibon_core::db::Db;
use kopibon_core::metadata::mappers::SystemClock;
use kopibon_core::nhentai::query::{
    build_search_query, dim_matches_json, match_dim_entries, BlockedEntry, GalleryFacts,
    SearchDefaults,
};
use kopibon_core::nhentai::tags::{resolve_gallery_tags, SqliteTagCache, TagsClient};
use serde_json::{json, Value};
use tauri::State;

use crate::auth::stored_setting;
use crate::envelope::{handle, CommandError, LogRecord, LogSink};
use crate::state::AppState;

use super::forward;

/// `SEARCH_SETTING_KEYS` (`search-settings.ipc.ts:68-85`).
const KEY_DEFAULT_QUERY: &str = "searchDefaultQuery";
const KEY_SORT: &str = "searchDefaultSort";
const KEY_LANGUAGE: &str = "searchDefaultLanguage";
const KEY_MIN_PAGES: &str = "searchMinPages";
const KEY_MIN_FAVORITES: &str = "searchMinFavorites";
const KEY_UPLOADED_WITHIN_DAYS: &str = "searchUploadedWithinDays";
const KEY_RESPECT_BLACKLIST: &str = "searchRespectBlacklist";
const KEY_REMEMBER_RECENT: &str = "searchRememberRecent";

/// The 5 API-accepted sorts (`:87`).
const VALID_SORTS: [&str; 5] = [
    "date",
    "popular",
    "popular-today",
    "popular-week",
    "popular-month",
];

/// `positiveInt` (`:95-99`): null when unset/unusable. Stored values are
/// written by `set` below as clean ints, so a strict parse matches the
/// `parseInt` outcome on every reachable value.
fn positive_int(raw: Option<String>) -> Option<i64> {
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    match raw.trim().parse::<i64>() {
        Ok(v) if v > 0 => Some(v),
        _ => None,
    }
}

fn non_empty(raw: Option<String>) -> Option<String> {
    match raw {
        Some(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// `readSearchSettings` (`:101-115`) as JSON.
fn read_settings_json(db: &Db) -> Value {
    let sort = stored_setting(db, KEY_SORT);
    json!({
        "defaultQuery": non_empty(stored_setting(db, KEY_DEFAULT_QUERY)),
        "sort": match sort {
            Some(ref s) if VALID_SORTS.contains(&s.as_str()) => s.clone(),
            _ => "date".to_string(),
        },
        "language": non_empty(stored_setting(db, KEY_LANGUAGE)),
        "minPages": positive_int(stored_setting(db, KEY_MIN_PAGES)),
        "minFavorites": positive_int(stored_setting(db, KEY_MIN_FAVORITES)),
        "uploadedWithinDays": positive_int(stored_setting(db, KEY_UPLOADED_WITHIN_DAYS)),
        "respectBlacklist": stored_setting(db, KEY_RESPECT_BLACKLIST).as_deref() == Some("true"),
        "rememberRecentSearches": stored_setting(db, KEY_REMEMBER_RECENT).as_deref() == Some("true"),
    })
}

/// `readSearchSettings` as the core `SearchDefaults` for the query builder.
/// `positiveInt` nulls become `None`; the builder's guards treat them as
/// unset (`min_pages > 0.0` fails on nothing — `None` skips).
fn read_search_defaults(db: &Db) -> (SearchDefaults, String, bool) {
    let value = read_settings_json(db);
    let opt_str = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let opt_f64 = |key: &str| value.get(key).and_then(Value::as_i64).map(|v| v as f64);
    (
        SearchDefaults {
            default_query: opt_str("defaultQuery"),
            sort: opt_str("sort"),
            language: opt_str("language"),
            min_pages: opt_f64("minPages"),
            min_favorites: opt_f64("minFavorites"),
            uploaded_within_days: opt_f64("uploadedWithinDays"),
        },
        opt_str("sort").unwrap_or_else(|| "date".to_string()),
        value
            .get("respectBlacklist")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// `searchSettings:get` (`:120-122`).
pub(crate) fn settings_get_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    Ok(json!({ "success": true, "data": read_settings_json(&state.db) }))
}

/// `searchSettings:set` (`:124-157`): patch → writes → fresh settings.
/// Only present keys are stored (`!== undefined`); explicit nulls take the
/// `??` fallbacks (`''`/`'date'`/`0`/`false`), exactly like 1.x.
pub(crate) fn settings_set_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    if let Some(patch) = args.first().and_then(|v| v.as_object()) {
        let mut writes: Vec<(String, String)> = Vec::new();
        if let Some(v) = patch.get(KEY_DEFAULT_QUERY) {
            writes.push((
                KEY_DEFAULT_QUERY.to_string(),
                v.as_str().unwrap_or("").trim().to_string(),
            ));
        }
        if let Some(v) = patch.get("sort") {
            let sort = v.as_str().unwrap_or("date");
            writes.push((
                KEY_SORT.to_string(),
                if VALID_SORTS.contains(&sort) {
                    sort.to_string()
                } else {
                    "date".to_string()
                },
            ));
        }
        if let Some(v) = patch.get("language") {
            writes.push((
                KEY_LANGUAGE.to_string(),
                v.as_str().unwrap_or("").trim().to_string(),
            ));
        }
        for (field, key) in [
            ("minPages", KEY_MIN_PAGES),
            ("minFavorites", KEY_MIN_FAVORITES),
            ("uploadedWithinDays", KEY_UPLOADED_WITHIN_DAYS),
        ] {
            if let Some(v) = patch.get(field) {
                writes.push((key.to_string(), v.as_i64().unwrap_or(0).to_string()));
            }
        }
        for (field, key) in [
            ("respectBlacklist", KEY_RESPECT_BLACKLIST),
            ("rememberRecentSearches", KEY_REMEMBER_RECENT),
        ] {
            if let Some(v) = patch.get(field) {
                writes.push((
                    key.to_string(),
                    if v.as_bool().unwrap_or(false) {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    },
                ));
            }
        }
        // NOTE: patch keys are the camelCase API names (`sort`,
        // `minPages`, …), not the storage keys — mapped above.
        state
            .db
            .with_writer(|conn| {
                for (key, value) in &writes {
                    kopibon_core::db::settings::set(conn, key, value)?;
                }
                Ok(())
            })
            .map_err(CommandError::Thrown)?;
    }
    Ok(json!({ "success": true, "data": read_settings_json(&state.db) }))
}

/// `searchSettings:buildQuery` (`:199-203`).
pub(crate) fn build_query_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let user_query = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let (defaults, sort, _) = read_search_defaults(&state.db);
    let blocked = state
        .db
        .with_reader(kopibon_core::db::blocked::entries)
        .map_err(CommandError::Thrown)?;
    let query = build_search_query(user_query, &defaults, &blocked);
    Ok(json!({ "success": true, "data": { "query": query, "sort": sort } }))
}

/// Gallery input shared by the two tag channels.
struct GalleryInput {
    id: i64,
    title: Option<String>,
    tag_ids: Vec<i64>,
    blacklisted: bool,
}

fn parse_galleries(args: &[Value]) -> Option<Vec<GalleryInput>> {
    let list = args.first().and_then(|v| v.as_array())?;
    let mut out = Vec::new();
    for gallery in list {
        let id = gallery.get("id")?.as_i64()?;
        let title = gallery
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let tag_ids = gallery
            .get("tag_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        let blacklisted = gallery
            .get("blacklisted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.push(GalleryInput {
            id,
            title,
            tag_ids,
            blacklisted,
        });
    }
    Some(out)
}

/// Resolve tags for a page of galleries through the shared client + a DB
/// reader (`resolveGalleryTags`, `tag-resolver.ts:87-103`).
fn resolve_tags(
    state: &AppState,
    galleries: &[GalleryInput],
) -> Result<std::collections::HashMap<i64, Vec<(String, String)>>, CommandError> {
    let pairs: Vec<(i64, Vec<i64>)> = galleries
        .iter()
        .map(|g| (g.id, g.tag_ids.clone()))
        .collect();
    let clock = SystemClock;
    let mut auth = state
        .auth
        .lock()
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))?;
    let by_gallery = state
        .db
        .with_reader(|conn| {
            let mut store = SqliteTagCache { conn };
            let client: &mut dyn TagsClient = auth.client_mut();
            Ok(resolve_gallery_tags(&mut store, client, &pairs, &clock)
                .into_iter()
                .map(|(id, tags)| (id, tags.into_iter().map(|t| (t.tag_type, t.name)).collect()))
                .collect())
        })
        .map_err(CommandError::Thrown)?;
    Ok(by_gallery)
}

/// `tags:resolveForGalleries` (`:211-222`): `{id: [{type, name}]}` as a
/// plain object — a Map does not survive structured clone (`:218-220`).
pub(crate) fn resolve_for_galleries_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let Some(galleries) = parse_galleries(args) else {
        return Ok(json!({ "success": true, "data": {} }));
    };
    if galleries.is_empty() {
        return Ok(json!({ "success": true, "data": {} }));
    }
    let by_gallery = resolve_tags(state, &galleries)?;
    let mut out = serde_json::Map::new();
    for gallery in &galleries {
        let tags: Vec<Value> = by_gallery
            .get(&gallery.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|(type_, name)| json!({ "type": type_, "name": name }))
            .collect();
        out.insert(gallery.id.to_string(), Value::Array(tags));
    }
    Ok(json!({ "success": true, "data": out }))
}

/// `search:evaluateResults` (`:235-296`).
pub(crate) fn evaluate_results_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let Some(galleries) = parse_galleries(args) else {
        return Ok(json!({ "success": true, "data": {} }));
    };
    if galleries.is_empty() {
        return Ok(json!({ "success": true, "data": {} }));
    }
    let (_, _, respect_blacklist) = read_search_defaults(&state.db);
    let all = state
        .db
        .with_reader(kopibon_core::db::blocked::entries)
        .map_err(CommandError::Thrown)?;
    let dim_entries: Vec<BlockedEntry> = all.iter().filter(|e| e.mode == "dim").cloned().collect();
    // `exclude` entries are recast as `dim` for result-side evaluation —
    // browse endpoints take no query, so exclusion only applies here
    // (`:250-263`).
    let exclude_as_dim: Vec<BlockedEntry> = all
        .iter()
        .filter(|e| e.mode == "exclude")
        .map(|e| BlockedEntry {
            type_: e.type_.clone(),
            value: e.value.clone(),
            mode: "dim".to_string(),
        })
        .collect();
    // Tag resolution only when a non-text entry needs it (`:265`).
    let needs_tags = dim_entries
        .iter()
        .chain(exclude_as_dim.iter())
        .any(|e| e.type_ != "text");
    let tags_by_gallery = if needs_tags {
        resolve_tags(state, &galleries)?
    } else {
        std::collections::HashMap::new()
    };
    let mut out = serde_json::Map::new();
    for gallery in &galleries {
        let empty = Vec::new();
        let tags = tags_by_gallery.get(&gallery.id).unwrap_or(&empty);
        let facts = GalleryFacts {
            title: gallery.title.as_deref(),
            tags,
        };
        let matches = match_dim_entries(&facts, &dim_entries);
        let excluded = !match_dim_entries(&facts, &exclude_as_dim).is_empty();
        let blacklisted = respect_blacklist && gallery.blacklisted;
        if !matches.is_empty() || blacklisted || excluded {
            out.insert(
                gallery.id.to_string(),
                json!({
                    "matches": dim_matches_json(&matches),
                    "blacklisted": blacklisted,
                    "excluded": excluded,
                }),
            );
        }
    }
    Ok(json!({ "success": true, "data": out }))
}

/// `blocked:list` (`:161-163`).
pub(crate) fn blocked_list_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    fresh_blocked_list(state)
}

fn fresh_blocked_list(state: &AppState) -> Result<Value, CommandError> {
    let items = state
        .db
        .with_reader(kopibon_core::db::blocked::list)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": items }))
}

/// `blocked:add` (`:171-178`).
pub(crate) fn blocked_add_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let submitted = args
        .first()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let entries: Vec<BlockedEntry> = submitted
        .iter()
        .map(|e| BlockedEntry {
            type_: e
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            value: e
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            mode: e
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    let submitted_count = entries.len();
    let added = state
        .db
        .with_writer(|conn| kopibon_core::db::blocked::add_many(conn, &entries))
        .map_err(CommandError::Thrown)?;
    log(LogRecord {
        level: "info",
        scope: "search-settings".to_string(),
        message: format!("Added {added} blocked value(s) of {submitted_count} submitted"),
        fields: json!({}),
    });
    let items = state
        .db
        .with_reader(kopibon_core::db::blocked::list)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": { "added": added, "items": items } }))
}

/// `blocked:setMode` (`:180-183`) → fresh list.
pub(crate) fn blocked_set_mode_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let mode = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
    state
        .db
        .with_writer(|conn| kopibon_core::db::blocked::set_mode(conn, id, mode))
        .map_err(CommandError::Thrown)?;
    fresh_blocked_list(state)
}

/// `blocked:remove` (`:185-187`) → fresh list.
pub(crate) fn blocked_remove_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    state
        .db
        .with_writer(|conn| kopibon_core::db::blocked::remove(conn, id))
        .map_err(CommandError::Thrown)?;
    fresh_blocked_list(state)
}

/// `tags:cacheStats` (`:314-316`).
pub(crate) fn cache_stats_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let cached = state
        .db
        .with_reader(kopibon_core::nhentai::tags::tag_cache_count)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": { "cached": cached } }))
}

macro_rules! search_command {
    ($fn_name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $fn_name(state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

search_command!(search_settings_get, "searchSettings:get", settings_get_impl);
search_command!(search_settings_set, "searchSettings:set", settings_set_impl);
search_command!(
    search_settings_build_query,
    "searchSettings:buildQuery",
    build_query_impl
);
search_command!(
    tags_resolve_for_galleries,
    "tags:resolveForGalleries",
    resolve_for_galleries_impl
);
search_command!(
    search_evaluate_results,
    "search:evaluateResults",
    evaluate_results_impl
);
search_command!(blocked_list, "blocked:list", blocked_list_impl);
search_command!(blocked_add, "blocked:add", blocked_add_impl);
search_command!(blocked_set_mode, "blocked:setMode", blocked_set_mode_impl);
search_command!(blocked_remove, "blocked:remove", blocked_remove_impl);
search_command!(tags_cache_stats, "tags:cacheStats", cache_stats_impl);

#[cfg(test)]
mod tests {
    use super::*;

    mod tempfile_guard {
        pub struct Guard {
            dir: std::path::PathBuf,
        }
        impl Guard {
            pub fn new() -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "kopibon-search-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&dir).expect("scratch dir");
                Guard { dir }
            }
            pub fn path(&self) -> &std::path::Path {
                &self.dir
            }
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
    }

    fn test_state() -> (AppState, tempfile_guard::Guard) {
        let guard = tempfile_guard::Guard::new();
        let state = AppState::open(guard.path().to_path_buf()).expect("scratch state");
        (state, guard)
    }

    /// Defaults read: invalid sort falls back, flags off, ints null.
    #[test]
    fn settings_defaults() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        let out = settings_get_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(
            out,
            json!({ "success": true, "data": {
                "defaultQuery": null, "sort": "date", "language": null,
                "minPages": null, "minFavorites": null, "uploadedWithinDays": null,
                "respectBlacklist": false, "rememberRecentSearches": false,
            } })
        );
    }

    /// Patch stores recognised keys and echoes fresh settings; bad sort
    /// falls back to date.
    #[test]
    fn settings_patch_round_trip() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        let out = settings_set_impl(
            &state,
            &[json!({ "sort": "bogus", "minPages": 10, "respectBlacklist": true })],
            &mut sink,
        )
        .expect("ok");
        let data = &out["data"];
        assert_eq!(data["sort"], json!("date"));
        assert_eq!(data["minPages"], json!(10));
        assert_eq!(data["respectBlacklist"], json!(true));
        // Unknown patch keys are ignored, not stored.
        let raw = state
            .db
            .with_reader(kopibon_core::db::settings::get_all)
            .expect("read");
        assert!(!raw.contains_key("bogus"));
    }

    /// Blocked CRUD: add (upsert on re-add), setMode, remove.
    #[test]
    fn blocked_crud() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        let out = blocked_add_impl(
            &state,
            &[json!([{ "type": "artist", "value": "  abc ", "mode": "dim" }, { "type": "nope", "value": "x", "mode": "dim" }])],
            &mut sink,
        )
        .expect("ok");
        assert_eq!(out["data"]["added"], json!(1));
        assert_eq!(out["data"]["items"].as_array().map(Vec::len), Some(1));
        let id = out["data"]["items"][0]["id"].as_i64().expect("id");
        assert_eq!(out["data"]["items"][0]["value"], json!("abc"));
        // Re-add same value with another mode → update, still counts.
        let out = blocked_add_impl(
            &state,
            &[json!([{ "type": "artist", "value": "ABC", "mode": "exclude" }])],
            &mut sink,
        )
        .expect("ok");
        assert_eq!(out["data"]["added"], json!(1));
        assert_eq!(out["data"]["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(out["data"]["items"][0]["mode"], json!("exclude"));
        // setMode flips, invalid mode ignored.
        blocked_set_mode_impl(&state, &[json!(id), json!("dim")], &mut sink).expect("ok");
        let out = blocked_list_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"][0]["mode"], json!("dim"));
        blocked_set_mode_impl(&state, &[json!(id), json!("bogus")], &mut sink).expect("ok");
        let out = blocked_list_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"][0]["mode"], json!("dim"));
        // remove drops.
        blocked_remove_impl(&state, &[json!(id)], &mut sink).expect("ok");
        let out = blocked_list_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out["data"].as_array().map(Vec::len), Some(0));
    }

    /// Text-only dim evaluation needs no network: title substring marks.
    #[test]
    fn evaluate_text_dim_without_network() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        blocked_add_impl(
            &state,
            &[json!([{ "type": "text", "value": "forbidden", "mode": "dim" }])],
            &mut sink,
        )
        .expect("ok");
        let out = evaluate_results_impl(
            &state,
            &[json!([
                { "id": 1, "title": "A FORBIDDEN tale" },
                { "id": 2, "title": "innocent" },
            ])],
            &mut sink,
        )
        .expect("ok");
        assert_eq!(
            out,
            json!({ "success": true, "data": {
                "1": { "matches": [{ "type": "text", "value": "forbidden" }], "blacklisted": false, "excluded": false },
            } })
        );
    }

    /// Empty/non-array gallery input → {} without touching anything.
    #[test]
    fn empty_gallery_input_is_empty_object() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        for args in [&[][..], &[json!([])][..], &[json!({})][..]] {
            let out = evaluate_results_impl(&state, args, &mut sink).expect("ok");
            assert_eq!(out, json!({ "success": true, "data": {} }));
            let out = resolve_for_galleries_impl(&state, args, &mut sink).expect("ok");
            assert_eq!(out, json!({ "success": true, "data": {} }));
        }
    }

    /// Tag cache stats start at zero.
    #[test]
    fn cache_stats_start_zero() {
        let (state, _guard) = test_state();
        let mut sink = |_: LogRecord| {};
        let out = cache_stats_impl(&state, &[], &mut sink).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": { "cached": 0 } }));
    }
}
