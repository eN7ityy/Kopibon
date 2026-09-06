//! tag-resolver.ts port — cache-first tag id resolution (04 §6).

use std::collections::HashMap;

use rusqlite::Connection;

use crate::metadata::mappers::Clock;

/// The documented maximum for GET /tags/ids (tag-resolver.ts:8).
pub const BATCH_SIZE: usize = 100;

/// Batches one resolve call will fetch (tag-resolver.ts:20) — the endpoint is
/// 15/min and dim mode degrades to "not dimmed yet", the safe direction.
pub const MAX_BATCHES_PER_CALL: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTag {
    pub tag_type: String,
    pub name: String,
}

/// The DB-facing half of the resolver (tag-cache.repo.ts methods the resolver
/// uses) so tests need no SQLite.
pub trait TagCacheStore {
    fn find_by_ids(&self, ids: &[i64]) -> Vec<(i64, String, String)>;
    fn upsert_many(&self, tags: &[(i64, String, String)], now_ms: i64);
}

/// tag_cache repo over the port's connection (tag-cache.repo.ts:18-49).
pub struct SqliteTagCache<'a> {
    pub conn: &'a Connection,
}

impl TagCacheStore for SqliteTagCache<'_> {
    fn find_by_ids(&self, ids: &[i64]) -> Vec<(i64, String, String)> {
        if ids.is_empty() {
            return Vec::new();
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let mut stmt = match self
            .conn
            .prepare(&format!("SELECT id, type, name FROM tag_cache WHERE id IN ({placeholders})"))
        {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .expect("tag_cache query");
        rows.filter_map(|r| r.ok()).collect()
    }

    fn upsert_many(&self, tags: &[(i64, String, String)], now_ms: i64) {
        for (id, tag_type, name) in tags {
            // Ignore anything without a usable id: id 0 is what older rows
            // stored when the real id was unknown (tag-cache.repo.ts:36-40).
            if *id == 0 || name.is_empty() {
                continue;
            }
            let resolved_type = if tag_type.is_empty() { "tag" } else { tag_type.as_str() };
            let _ = self.conn.execute(
                "INSERT INTO tag_cache (id, type, name, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   type = excluded.type,
                   name = excluded.name,
                   updated_at = excluded.updated_at",
                rusqlite::params![id, resolved_type, name, now_ms],
            );
        }
    }
}

/// tag-cache row count (`tag-cache.repo.ts:61-66` `count()`).
pub fn tag_cache_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM tag_cache", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// The client surface the resolver needs (getTagsByIds), so tests can fake it.
pub trait TagsClient {
    /// 100 ids max, deduped, positive integers only — the caller batches.
    fn get_tags_by_ids(&mut self, ids: &[i64]) -> Result<Vec<(i64, String, String)>, String>;
}

/// resolveTagNames (tag-resolver.ts:34-79): always returns whatever is known;
/// an empty answer means "not known yet", never an error.
pub fn resolve_tag_names(
    store: &mut dyn TagCacheStore,
    client: &mut dyn TagsClient,
    ids: &[i64],
    clock: &dyn Clock,
) -> HashMap<i64, ResolvedTag> {
    let mut resolved: HashMap<i64, ResolvedTag> = HashMap::new();
    // Dedup + positive-int filter (:36).
    let mut wanted: Vec<i64> = Vec::new();
    for id in ids {
        if *id > 0 && !wanted.contains(id) {
            wanted.push(*id);
        }
    }
    if wanted.is_empty() {
        return resolved;
    }

    for (id, tag_type, name) in store.find_by_ids(&wanted) {
        resolved.insert(id, ResolvedTag { tag_type, name });
    }

    let missing: Vec<i64> = wanted.iter().copied().filter(|id| !resolved.contains_key(id)).collect();
    if missing.is_empty() {
        return resolved;
    }

    let batches: Vec<&[i64]> = missing.chunks(BATCH_SIZE).collect();
    let capped = batches.len().min(MAX_BATCHES_PER_CALL);

    for batch in batches.into_iter().take(capped) {
        match client.get_tags_by_ids(batch) {
            Ok(tags) => {
                if tags.is_empty() {
                    continue;
                }
                store.upsert_many(&tags, clock.now_ms());
                for (id, tag_type, name) in tags {
                    if id > 0 && !name.is_empty() {
                        resolved.insert(id, ResolvedTag { tag_type, name });
                    }
                }
            }
            Err(_) => {
                // Rate limiting is the expected failure. Stop rather than
                // hammering the remaining batches, keep what resolved (:70-75).
                break;
            }
        }
    }

    resolved
}

/// resolveGalleryTags (tag-resolver.ts:87-103): every gallery's ids in one
/// pass so common tags resolve once for the page.
pub fn resolve_gallery_tags(
    store: &mut dyn TagCacheStore,
    client: &mut dyn TagsClient,
    galleries: &[(i64, Vec<i64>)],
    clock: &dyn Clock,
) -> HashMap<i64, Vec<ResolvedTag>> {
    let every_id: Vec<i64> = galleries.iter().flat_map(|(_, ids)| ids.iter().copied()).collect();
    let lookup = resolve_tag_names(store, client, &every_id, clock);

    let mut by_gallery = HashMap::new();
    for (gallery_id, tag_ids) in galleries {
        let tags: Vec<ResolvedTag> = tag_ids
            .iter()
            .filter_map(|id| lookup.get(id).cloned())
            .collect();
        by_gallery.insert(*gallery_id, tags);
    }
    by_gallery
}

/// Adapter: the real client's getTagsByIds (including its dedup/cap checks)
/// behind TagsClient.
impl<T: crate::nhentai::http::Transport> TagsClient for crate::nhentai::ApiClient<T> {
    fn get_tags_by_ids(&mut self, ids: &[i64]) -> Result<Vec<(i64, String, String)>, String> {
        let tags = crate::nhentai::ApiClient::get_tags_by_ids(self, ids, &crate::metadata::mappers::SystemClock)?;
        Ok(tags
            .into_iter()
            .map(|t| (t.id, t.tag_type, t.name))
            .collect())
    }
}
