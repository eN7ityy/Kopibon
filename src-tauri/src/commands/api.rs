//! `api:*` commands (02-ipc-surface §2.1, `api.ipc.ts:54-145`).
//!
//! Thin envelope over the shared client (`AuthState::client_mut` — the same
//! singleton the auth handlers arm, one limiter). The core returns raw
//! `ResponseDef`s; JSON parsing happens here, matching 1.x's
//! `request<T>`: 204/empty → null, anything else parsed (a parse failure
//! throws into the envelope, like 1.x's `response.json()` rejection).
//! Gallery details ride the shared LRU (`ApiState`); related lists do not
//! (they are `GalleryListItem[]`, not the cached `GalleryDetail`).

use kopibon_core::metadata::mappers::{Clock, SystemClock};
use kopibon_core::nhentai::http::ResponseDef;
use serde_json::{json, Value};
use tauri::State;

use crate::api::autocomplete_key;
use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// `request<T>` body mapping (`api-client.ts:237-247`).
fn body_value(response: Option<ResponseDef>) -> Result<Value, CommandError> {
    match response {
        None => Ok(Value::Null),
        Some(resp) if resp.body.is_empty() => Ok(Value::Null),
        Some(resp) => serde_json::from_str(&resp.body)
            .map_err(|e| CommandError::Thrown(format!("failed to parse JSON: {e}"))),
    }
}

fn lock_auth(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, crate::auth::AuthState>, CommandError> {
    state
        .auth
        .lock()
        .map_err(|_| CommandError::Thrown("auth lock poisoned".to_string()))
}

/// `api:search` (`api.ipc.ts:57-76`): `(query, {page?, sort?})`.
pub(crate) fn search_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let query = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let options = args.get(1);
    let page = options.and_then(|o| o.get("page")).and_then(Value::as_i64);
    let sort = options.and_then(|o| o.get("sort")).and_then(Value::as_str);
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .search_galleries(query, page, sort, &clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getLatest` (`:78-81`): `(page?)`, `?? 1`.
pub(crate) fn latest_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let page = args.first().and_then(Value::as_i64).unwrap_or(1);
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_latest_galleries(page, &clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getPopular` (`:83-86`).
pub(crate) fn popular_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_popular_galleries(&clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getGallery` (`:88-96`): LRU-cached by id.
pub(crate) fn gallery_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let clock = SystemClock;
    let now = clock.now_ms();
    let key = id.to_string();
    if let Ok(mut cache) = state.api.gallery_cache.lock() {
        if let Some(hit) = cache.get(&key, now) {
            return Ok(json!({ "success": true, "data": hit }));
        }
    }
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_gallery(id, &clock)
        .map_err(CommandError::Thrown)?;
    let value = body_value(response)?;
    if let Ok(mut cache) = state.api.gallery_cache.lock() {
        cache.put(key, value.clone(), now);
    }
    Ok(json!({ "success": true, "data": value }))
}

/// `api:getCdnConfig` (`:98-101`).
pub(crate) fn cdn_config_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_cdn_config_raw(&clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getConfig` (`:103-106`).
pub(crate) fn config_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_config(&clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:setApiKey` (`:108-111`): `(key|null)` → bare success.
pub(crate) fn set_api_key_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let key = args.first().and_then(|v| v.as_str());
    lock_auth(state)?.set_api_key_opt(key);
    Ok(json!({ "success": true }))
}

/// `api:getFavorites` (`:113-119`): `(page, query?)`.
pub(crate) fn favorites_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let page = args.first().and_then(Value::as_i64).unwrap_or(1);
    let query = args.get(1).and_then(|v| v.as_str());
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_favorites(page, query, &clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getUser` (`:121-124`).
pub(crate) fn user_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_user(&clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:getRelatedGalleries` (`:126-131`): never cached (list items, not
/// detail).
pub(crate) fn related_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let response = auth
        .client_mut()
        .get_related_galleries(id, &clock)
        .map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": body_value(response)? }))
}

/// `api:addFavorite` (`:133-138`): invalidates the cached detail whose
/// `num_favorites` just changed.
pub(crate) fn add_favorite_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    mutate_favorite(state, args, true)
}

/// `api:removeFavorite` (`:140-144`).
pub(crate) fn remove_favorite_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    mutate_favorite(state, args, false)
}

fn mutate_favorite(state: &AppState, args: &[Value], add: bool) -> Result<Value, CommandError> {
    let gallery_id = args.first().and_then(Value::as_i64).unwrap_or(0);
    let clock = SystemClock;
    let mut auth = lock_auth(state)?;
    let client = auth.client_mut();
    let response = if add {
        client.add_favorite(gallery_id, &clock)
    } else {
        client.remove_favorite(gallery_id, &clock)
    }
    .map_err(CommandError::Thrown)?;
    let _ = body_value(response)?;
    if let Ok(mut cache) = state.api.gallery_cache.lock() {
        cache.invalidate(&gallery_id.to_string());
    }
    Ok(json!({ "success": true }))
}

macro_rules! api_command {
    ($fn_name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $fn_name(state: State<AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

api_command!(api_search, "api:search", search_impl);
api_command!(api_get_latest, "api:getLatest", latest_impl);
api_command!(api_get_popular, "api:getPopular", popular_impl);
api_command!(api_get_gallery, "api:getGallery", gallery_impl);
api_command!(api_get_cdn_config, "api:getCdnConfig", cdn_config_impl);
api_command!(api_get_config, "api:getConfig", config_impl);
api_command!(api_set_api_key, "api:setApiKey", set_api_key_impl);
api_command!(api_get_favorites, "api:getFavorites", favorites_impl);
api_command!(api_get_user, "api:getUser", user_impl);
api_command!(
    api_get_related_galleries,
    "api:getRelatedGalleries",
    related_impl
);
api_command!(api_add_favorite, "api:addFavorite", add_favorite_impl);
api_command!(
    api_remove_favorite,
    "api:removeFavorite",
    remove_favorite_impl
);

/// `tags:autocomplete` body (`search-settings.ipc.ts:298-312`) lives here
/// with the client, but is registered under its own channel: cached by
/// `type:query`, 15 results, mapped to `{id, type, name, count}`.
pub(crate) fn autocomplete_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let query = args.first().and_then(|v| v.as_str()).unwrap_or("");
    let tag_type = args.get(1).and_then(|v| v.as_str());
    let clock = SystemClock;
    let now = clock.now_ms();
    let key = autocomplete_key(query, tag_type);
    if let Ok(mut cache) = state.api.autocomplete_cache.lock() {
        if let Some(hit) = cache.get(&key, now) {
            return Ok(json!({ "success": true, "data": hit }));
        }
    }
    let mut auth = lock_auth(state)?;
    let tags = auth
        .client_mut()
        .search_tags(query, tag_type, Some(15), &clock)
        .map_err(CommandError::Thrown)?;
    let data: Vec<Value> = tags
        .iter()
        .map(|tag| {
            json!({ "id": tag.id, "type": tag.tag_type, "name": tag.name, "count": tag.count })
        })
        .collect();
    if let Ok(mut cache) = state.api.autocomplete_cache.lock() {
        cache.put(key, data.clone(), now);
    }
    Ok(json!({ "success": true, "data": data }))
}

#[tauri::command(rename = "tags:autocomplete")]
pub(crate) fn tags_autocomplete(state: State<AppState>, args: Vec<Value>) -> Value {
    let outcome = handle("tags:autocomplete", |log| {
        autocomplete_impl(&state, &args, log)
    });
    forward(&state, "tags:autocomplete", outcome.logs);
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empty-body and None responses map to null (1.x `request<T>` returns
    /// undefined for 204/empty); anything else parses.
    #[test]
    fn body_mapping() {
        assert_eq!(body_value(None).expect("none"), Value::Null);
        assert_eq!(
            body_value(Some(ResponseDef {
                status: 200,
                status_text: "OK".to_string(),
                headers: vec![],
                body: String::new(),
            }))
            .expect("empty"),
            Value::Null
        );
        assert_eq!(
            body_value(Some(ResponseDef {
                status: 200,
                status_text: "OK".to_string(),
                headers: vec![],
                body: r#"{"a":1}"#.to_string(),
            }))
            .expect("json"),
            json!({ "a": 1 })
        );
        assert!(matches!(
            body_value(Some(ResponseDef {
                status: 200,
                status_text: "OK".to_string(),
                headers: vec![],
                body: "not json".to_string(),
            })),
            Err(CommandError::Thrown(_))
        ));
    }
}
