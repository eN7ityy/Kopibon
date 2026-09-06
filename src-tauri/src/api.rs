//! Shared nhentai API state (`src/main/ipc/api.ipc.ts:4-52`).
//!
//! Two bounded LRU caches live here: gallery details (300 entries / 15 min
//! — previously unbounded and served stale favourite counts forever) and
//! tag autocomplete (200 entries / 5 min — the search box re-queries each
//! prefix against a 30-req/min endpoint). Map insertion order gives LRU
//! eviction; hits re-insert to mark recency.

use std::collections::HashMap;
use std::sync::Mutex;

/// Gallery detail cache limits (`api.ipc.ts:13-14`).
pub const GALLERY_CACHE_MAX_ENTRIES: usize = 300;
pub const GALLERY_CACHE_TTL_MS: i64 = 15 * 60_000;
/// Autocomplete cache limits (`search-settings.ipc.ts:24-25`).
pub const AUTOCOMPLETE_CACHE_MAX_ENTRIES: usize = 200;
pub const AUTOCOMPLETE_CACHE_TTL_MS: i64 = 5 * 60_000;

/// Insertion-ordered LRU map: `get` re-inserts on hit, `put` evicts the
/// oldest past capacity. TTL expiry is by wall clock (`now_ms`).
pub struct LruCache<V: Clone> {
    max_entries: usize,
    ttl_ms: i64,
    order: Vec<String>,
    values: HashMap<String, (V, i64)>,
}

impl<V: Clone> LruCache<V> {
    pub fn new(max_entries: usize, ttl_ms: i64) -> Self {
        LruCache {
            max_entries,
            ttl_ms,
            order: Vec::new(),
            values: HashMap::new(),
        }
    }

    /// Cache read (`getCachedGallery`, `api.ipc.ts:23-36`): expired entries
    /// are dropped and miss; hits re-insert as most-recently-used.
    pub fn get(&mut self, key: &str, now_ms: i64) -> Option<V> {
        let (value, cached_at) = self.values.get(key)?.clone();
        if now_ms - cached_at > self.ttl_ms {
            self.values.remove(key);
            self.order.retain(|k| k != key);
            return None;
        }
        self.order.retain(|k| k != key);
        self.order.push(key.to_string());
        Some(value)
    }

    /// Cache write (`setCachedGallery`, `api.ipc.ts:38-47`).
    pub fn put(&mut self, key: String, value: V, now_ms: i64) {
        self.values.insert(key.clone(), (value, now_ms));
        self.order.retain(|k| k != &key);
        self.order.push(key);
        while self.order.len() > self.max_entries {
            let oldest = self.order.remove(0);
            self.values.remove(&oldest);
        }
    }

    /// Drop an entry known-changed (`invalidateCachedGallery`, `:50-52`).
    pub fn invalidate(&mut self, key: &str) {
        self.values.remove(key);
        self.order.retain(|k| k != key);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.values.len()
    }
}

/// Autocomplete cache key: type is part of it (`:35-37`).
pub fn autocomplete_key(query: &str, tag_type: Option<&str>) -> String {
    format!("{}:{}", tag_type.unwrap_or(""), query.to_lowercase())
}

/// The shared `api:*` state (gallery + autocomplete caches).
pub struct ApiState {
    pub gallery_cache: Mutex<LruCache<serde_json::Value>>,
    pub autocomplete_cache: Mutex<LruCache<Vec<serde_json::Value>>>,
}

impl ApiState {
    pub fn new() -> Self {
        ApiState {
            gallery_cache: Mutex::new(LruCache::new(
                GALLERY_CACHE_MAX_ENTRIES,
                GALLERY_CACHE_TTL_MS,
            )),
            autocomplete_cache: Mutex::new(LruCache::new(
                AUTOCOMPLETE_CACHE_MAX_ENTRIES,
                AUTOCOMPLETE_CACHE_TTL_MS,
            )),
        }
    }
}

impl Default for ApiState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expiry, LRU re-insertion on hit, capacity eviction.
    #[test]
    fn lru_semantics() {
        let mut cache = LruCache::new(2, 1_000);
        cache.put("a".to_string(), 1, 0);
        cache.put("b".to_string(), 2, 0);
        // Hit on `a` makes `b` the oldest.
        assert_eq!(cache.get("a", 500), Some(1));
        cache.put("c".to_string(), 3, 500);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("b", 500), None);
        assert_eq!(cache.get("a", 500), Some(1));
        // Expired entries miss and are dropped.
        assert_eq!(cache.get("a", 500 + 1_001), None);
        assert_eq!(cache.len(), 1);
        // Invalidate drops.
        cache.invalidate("c");
        assert_eq!(cache.len(), 0);
    }

    /// Type is part of the autocomplete key; query lowercased.
    #[test]
    fn autocomplete_key_shape() {
        assert_eq!(autocomplete_key("ABC", Some("artist")), "artist:abc");
        assert_eq!(autocomplete_key("ABC", None), ":abc");
        assert_ne!(
            autocomplete_key("x", Some("tag")),
            autocomplete_key("x", None)
        );
    }
}
