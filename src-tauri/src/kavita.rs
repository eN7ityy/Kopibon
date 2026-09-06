//! Kavita shell state (`src/main/services/kavita-client.ts` shell side).
//!
//! Config is read from `app_settings` at call time (a save takes effect on
//! the next call — `kavita-client.ts:10-12`); the persisted API key is
//! decrypted through the auth keychain layer, while explicit overrides are
//! plaintext the caller already holds (`readConfig`, `:155-163`). `??`
//! semantics: an override wins even when empty — only null/absent falls
//! back to settings.
//!
//! The status-bar item-count cache (`itemCountCache`, `:127-133`) lives
//! here: 60 s TTL, and a failed refetch serves the STALE value (`:332-337`)
//! rather than null. Later write-path batches (scan/delete mirroring)
//! invalidate it through [`KavitaState::invalidate_item_count`].

use kopibon_core::db::Db;
use kopibon_core::kavita::KavitaConfig;
use std::sync::Mutex;
use std::time::Duration;

use crate::auth::{decrypt_key, stored_setting, UreqTransport, KAVITA_KEY_ACCOUNT};

/// `REQUEST_TIMEOUT_MS` (kavita-client.ts:116).
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(10_000);
/// `ITEM_COUNT_STALE_MS` (kavita-client.ts:132).
pub const ITEM_COUNT_STALE_MS: i64 = 60_000;

/// Shell-owned Kavita state: the blocking transport plus the item-count
/// cache. Per-call [`KavitaClient`](kopibon_core::kavita::KavitaClient)s
/// borrow the transport (the core client holds `&T`, so it cannot live in
/// state — the cache is what persists across calls, exactly like 1.x's
/// module-scope `itemCountCache`).
pub struct KavitaState {
    transport: UreqTransport,
    item_count: Mutex<Option<(i64, i64)>>,
}

impl KavitaState {
    pub fn new() -> Self {
        KavitaState {
            transport: UreqTransport::with_global_timeout(REQUEST_TIMEOUT),
            item_count: Mutex::new(None),
        }
    }

    pub fn transport(&self) -> &UreqTransport {
        &self.transport
    }

    /// Cached count when fresh (`getItemCount`, `:313-318`).
    pub fn fresh_item_count(&self, now_ms: i64) -> Option<i64> {
        self.item_count
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .filter(|(_, at)| now_ms - *at < ITEM_COUNT_STALE_MS)
            .map(|(count, _)| count)
    }

    /// Last cached count regardless of age — the stale fallback a failed
    /// refetch serves (`:336`).
    pub fn stale_item_count(&self) -> Option<i64> {
        self.item_count
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .map(|(count, _)| count)
    }

    pub fn store_item_count(&self, count: i64, now_ms: i64) {
        if let Ok(mut guard) = self.item_count.lock() {
            *guard = Some((count, now_ms));
        }
    }

    /// `markItemCountStale` (`:344-346`): only when a count was cached.
    /// First caller is the scan/delete mirroring (later batch).
    #[allow(dead_code)]
    pub fn invalidate_item_count(&self) {
        if let Ok(mut guard) = self.item_count.lock() {
            if guard.is_some() {
                *guard = None;
            }
        }
    }
}

impl Default for KavitaState {
    fn default() -> Self {
        Self::new()
    }
}

/// `kavitaEnabled === 'true'` — gates `isConfigured()` (`:178-182`) and
/// `getItemCount` (`:309`), but NOT the settings pane's own test/list
/// calls, which pass overrides and hit the endpoints directly (`:173-176`).
pub fn is_enabled(db: &Db) -> bool {
    stored_setting(db, "kavitaEnabled").as_deref() == Some("true")
}

/// `readConfig` (`:155-163`) with per-channel overrides. `url`/`apiKey`
/// fall back to settings only when the override is absent (not merely
/// empty); the persisted key is decrypted, overrides never are; everything
/// is trimmed, and the URL's trailing slashes are stripped by
/// [`KavitaConfig::read`].
pub fn effective_config(
    db: &Db,
    url_override: Option<&str>,
    key_override: Option<&str>,
) -> KavitaConfig {
    let stored_url = stored_setting(db, "kavitaUrl").unwrap_or_default();
    let stored_key = stored_setting(db, "kavitaApiKey").unwrap_or_default();
    let stored_library = stored_setting(db, "kavitaLibraryId").unwrap_or_default();
    let url = url_override.unwrap_or(&stored_url);
    let api_key = match key_override {
        Some(plain) => plain.trim().to_string(),
        None => decrypt_key(KAVITA_KEY_ACCOUNT, &stored_key)
            .trim()
            .to_string(),
    };
    KavitaConfig::read(Some((url, &api_key, &stored_library)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    mod tempfile_guard {
        pub struct Guard {
            dir: std::path::PathBuf,
        }
        impl Guard {
            pub fn new() -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "kopibon-kavita-test-{}-{}",
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

    /// Disabled by default: `is_enabled` is false on a fresh DB.
    #[test]
    fn disabled_by_default() {
        let (state, _guard) = test_state();
        assert!(!is_enabled(&state.db));
    }

    /// Overrides win even when empty (`??`, not `||`); absent falls back.
    #[test]
    fn override_semantics() {
        let (state, _guard) = test_state();
        state
            .db
            .with_writer(|conn| kopibon_core::db::settings::set(conn, "kavitaUrl", "http://saved/"))
            .expect("seed");
        // Absent → settings (trailing slash stripped by KavitaConfig::read).
        let cfg = effective_config(&state.db, None, None);
        assert_eq!(cfg.url, "http://saved");
        // Empty override wins over settings.
        let cfg = effective_config(&state.db, Some(""), None);
        assert_eq!(cfg.url, "");
        // Present override wins.
        let cfg = effective_config(&state.db, Some("http://form/"), None);
        assert_eq!(cfg.url, "http://form");
    }

    /// Fresh/stale cache behaviour mirrors `itemCountCache`.
    #[test]
    fn item_count_cache_windows() {
        let (state, _guard) = test_state();
        let kavita = state.kavita.lock().expect("lock");
        assert_eq!(kavita.fresh_item_count(1_000), None);
        assert_eq!(kavita.stale_item_count(), None);
        kavita.store_item_count(41, 1_000);
        assert_eq!(
            kavita.fresh_item_count(1_000 + ITEM_COUNT_STALE_MS - 1),
            Some(41)
        );
        assert_eq!(kavita.fresh_item_count(1_000 + ITEM_COUNT_STALE_MS), None);
        // Stale serves regardless of age (the failed-refetch fallback).
        assert_eq!(kavita.stale_item_count(), Some(41));
    }
}
