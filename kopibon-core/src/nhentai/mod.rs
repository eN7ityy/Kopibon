//! nhentai client port (api-client.ts + rate-limiter.ts + tag-resolver.ts +
//! search-query.ts + the sync fetch) — 04-subsystem-plans.
//!
//! `http.rs` is the only place that touches the network. Phase A runs on the
//! replay transport; the reqwest transport lands with the download manager's
//! runtime (WP-A8) behind the same trait. Both UAs and both retry models stay
//! separate (04 §4.3).

pub mod http;
pub mod limiter;
pub mod query;
pub mod sync_fetch;
pub mod tags;
pub mod types;

use crate::metadata::mappers::Clock;
use http::{RequestDef, ResponseDef, Transport};
use limiter::{ApiRateLimiter, EndpointKey};
pub use types::*;

/// The `setTimeout` seam of the 429 path (api-client.ts:193): production
/// sleeps for real, tests record the wait. `Send` so the client can live in
/// shared app state (Phase B `AuthState`); test recorders use `Arc`.
pub type Sleeper = Box<dyn FnMut(i64) + Send>;

pub fn real_sleeper() -> Sleeper {
    Box::new(|ms: i64| std::thread::sleep(std::time::Duration::from_millis(ms.max(0) as u64)))
}

pub const BASE_URL: &str = "https://nhentai.net/api/v2";
/// Client UA — verbatim (api-client.ts:159); the sync fetch uses the other
/// string (sync_fetch.rs).
pub const CLIENT_USER_AGENT: &str = "Doujin-Downloader/1.0";
/// /cdn cache lifetime (api-client.ts:242).
pub const CDN_CACHE_MS: i64 = 3_600_000;

/// ApiClient facade (api-client.ts:128-348), generic over the transport.
pub struct ApiClient<T: Transport> {
    pub transport: T,
    pub limiter: ApiRateLimiter,
    pub sleep: Sleeper,
    api_key: Option<String>,
    cdn_config: Option<CdnConfig>,
    cdn_config_fetched_at: i64,
}

impl<T: Transport> ApiClient<T> {
    pub fn new(transport: T, authenticated: bool, now: i64) -> Self {
        ApiClient {
            transport,
            limiter: ApiRateLimiter::new(authenticated, now),
            sleep: real_sleeper(),
            api_key: None,
            cdn_config: None,
            cdn_config_fetched_at: 0,
        }
    }

    pub fn set_api_key(&mut self, key: Option<&str>, now: i64) {
        self.api_key = key.map(|k| k.to_string());
        // Authenticated calls get higher per-endpoint allowances.
        self.limiter.set_authenticated(key.is_some(), now);
    }

    pub fn set_authenticated(&mut self, authenticated: bool, now: i64) {
        self.limiter.set_authenticated(authenticated, now);
    }

    /// getHeaders (:157-166).
    fn headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            ("User-Agent".to_string(), CLIENT_USER_AGENT.to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        if let Some(key) = &self.api_key {
            headers.push(("Authorization".to_string(), format!("Key {key}")));
        }
        headers
    }

    /// request (:168-207): acquire a token, send, honour one 429 retry with
    /// Retry-After (capped 60 s, default 5 s), error `API error: {status}
    /// {statusText}`, 204 → no body.
    fn request(
        &mut self,
        endpoint: EndpointKey,
        path: &str,
        method: &str,
        body: Option<String>,
        clock: &dyn Clock,
    ) -> Result<Option<ResponseDef>, String> {
        self.limiter.acquire(endpoint, clock);

        let mut headers = self.headers();
        if body.is_some() {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }

        let send = |transport: &T, headers: &[(String, String)]| -> Result<ResponseDef, String> {
            transport.send(&RequestDef {
                method: method.to_string(),
                url: format!("{BASE_URL}{path}"),
                headers: headers.to_vec(),
                body: body.clone(),
            })
        };

        let mut response = send(&self.transport, &headers)?;

        if response.status == 429 {
            // Honour Retry-After when the server sends it, else back off 5s.
            let retry_after = response
                .header("Retry-After")
                .map(|h| {
                    let t = h.trim();
                    t.parse::<f64>().unwrap_or(f64::NAN)
                })
                .unwrap_or(f64::NAN);
            let wait_ms = if retry_after.is_finite() && retry_after > 0.0 {
                (retry_after * 1000.0) as i64
            } else {
                5000
            }
            .min(60_000);
            (self.sleep)(wait_ms);
            self.limiter.acquire(endpoint, clock);
            response = send(&self.transport, &headers)?;
        }

        if !(200..300).contains(&response.status) {
            return Err(format!(
                "API error: {} {}",
                response.status, response.status_text
            ));
        }

        if response.status == 204 {
            return Ok(None);
        }
        Ok(Some(response))
    }

    /// searchGalleries (:209-219): `sort` omitted when `date`.
    pub fn search_galleries(
        &mut self,
        query: &str,
        page: Option<i64>,
        sort: Option<&str>,
        clock: &dyn Clock,
    ) -> Result<Option<ResponseDef>, String> {
        let mut params = vec![format!("query={}", http::urlencoded_encode(query))];
        if let Some(p) = page {
            // `if (options.page)` — 0 is falsy and omitted.
            if p != 0 {
                params.push(format!("page={p}"));
            }
        }
        if let Some(s) = sort {
            if s != "date" {
                params.push(format!("sort={}", http::urlencoded_encode(s)));
            }
        }
        self.request(EndpointKey::Search, &format!("/search?{}", params.join("&")), "GET", None, clock)
    }

    /// getLatestGalleries (:221-225).
    pub fn get_latest_galleries(
        &mut self,
        page: i64,
        clock: &dyn Clock,
    ) -> Result<Option<ResponseDef>, String> {
        self.request(
            EndpointKey::Galleries,
            &format!("/galleries?page={}", http::urlencoded_encode(&page.to_string())),
            "GET",
            None,
            clock,
        )
    }

    /// getPopularGalleries (:227-230).
    pub fn get_popular_galleries(&mut self, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::Popular, "/galleries/popular", "GET", None, clock)
    }

    /// getGallery (:232-238): `?include=favorite` only with a key.
    pub fn get_gallery(&mut self, id: i64, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        let query = if self.api_key.is_some() { "?include=favorite" } else { "" };
        self.request(EndpointKey::Gallery, &format!("/galleries/{id}{query}"), "GET", None, clock)
    }

    /// getCdnConfig (:240-249): client cache of one hour.
    pub fn get_cdn_config_raw(&mut self, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        let now = clock.now_ms();
        if self.cdn_config.is_some() && now - self.cdn_config_fetched_at < CDN_CACHE_MS {
            return Ok(None); // cache hit — no request
        }
        let response = self.request(EndpointKey::Meta, "/cdn", "GET", None, clock)?;
        if let Some(resp) = &response {
            if let Ok(config) = serde_json::from_str::<CdnConfig>(&resp.body) {
                self.cdn_config = Some(config);
                self.cdn_config_fetched_at = now;
            }
        }
        Ok(response)
    }

    /// getConfig (:251-253).
    pub fn get_config(&mut self, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::Meta, "/config", "GET", None, clock)
    }

    /// getUser (:255-257).
    pub fn get_user(&mut self, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::User, "/user", "GET", None, clock)
    }

    /// getFavorites (:259-265): note `q`, not `query`.
    pub fn get_favorites(
        &mut self,
        page: i64,
        query: Option<&str>,
        clock: &dyn Clock,
    ) -> Result<Option<ResponseDef>, String> {
        let mut params = vec![format!("page={page}")];
        if let Some(q) = query {
            if !q.is_empty() {
                params.push(format!("q={}", http::urlencoded_encode(q)));
            }
        }
        self.request(EndpointKey::Favorites, &format!("/favorites?{}", params.join("&")), "GET", None, clock)
    }

    /// getRelatedGalleries (:267-269).
    pub fn get_related_galleries(&mut self, id: i64, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::Related, &format!("/galleries/{id}/related"), "GET", None, clock)
    }

    /// getTagsByIds (:279-286): max 100 ids, dedup + positive-int filter.
    pub fn get_tags_by_ids(
        &mut self,
        ids: &[i64],
        clock: &dyn Clock,
    ) -> Result<Vec<TagResponse>, String> {
        let mut unique: Vec<i64> = Vec::new();
        for id in ids {
            if *id > 0 && !unique.contains(id) {
                unique.push(*id);
            }
        }
        if unique.is_empty() {
            return Ok(Vec::new());
        }
        if unique.len() > 100 {
            return Err(format!(
                "getTagsByIds accepts at most 100 ids, got {}",
                unique.len()
            ));
        }
        let ids_list = unique
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let response = self.request(EndpointKey::TagsIds, &format!("/tags/ids?ids={ids_list}"), "GET", None, clock)?;
        match response {
            Some(resp) => serde_json::from_str(&resp.body)
                .map_err(|e| format!("failed to parse JSON: {e}")),
            None => Ok(Vec::new()),
        }
    }

    /// searchTags (:295-311): limit clamped 1–50, `type: null` searches all.
    pub fn search_tags(
        &mut self,
        query: &str,
        type_filter: Option<&str>,
        limit: Option<i64>,
        clock: &dyn Clock,
    ) -> Result<Vec<TagResponse>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // JSON.stringify({query, type, limit}) — insertion order matters for
        // request-body parity, so build the body literally.
        let limit_clamped = (limit.unwrap_or(10).clamp(1, 50)).to_string();
        let type_json = match type_filter {
            Some(t) if !t.is_empty() => serde_json::to_string(t).unwrap_or_else(|_| "null".into()),
            _ => "null".to_string(),
        };
        let body = format!(
            "{{\"query\":{},\"type\":{type_json},\"limit\":{limit_clamped}}}",
            serde_json::to_string(trimmed).unwrap_or_else(|_| "\"\"".into())
        );
        let response = self.request(EndpointKey::TagsSearch, "/tags/search", "POST", Some(body), clock)?;
        match response {
            Some(resp) => serde_json::from_str(&resp.body)
                .map_err(|e| format!("failed to parse JSON: {e}")),
            None => Ok(Vec::new()),
        }
    }

    /// addFavorite / removeFavorite (:313-319): 204 → no body.
    pub fn add_favorite(&mut self, gallery_id: i64, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::Favorite, &format!("/galleries/{gallery_id}/favorite"), "POST", None, clock)
    }

    pub fn remove_favorite(&mut self, gallery_id: i64, clock: &dyn Clock) -> Result<Option<ResponseDef>, String> {
        self.request(EndpointKey::Favorite, &format!("/galleries/{gallery_id}/favorite"), "DELETE", None, clock)
    }

    /// getImageUrl (:324-330): first image server only — rotation belongs to
    /// the download manager; new code must not rely on this.
    pub fn get_image_url(&mut self, media_id: &str, page_number: i64, page_path: &str, clock: &dyn Clock) -> Result<String, String> {
        let config = self.cached_cdn_config(clock)?;
        let server = config
            .image_servers
            .first()
            .ok_or_else(|| "API error: no image servers".to_string())?;
        // pagePath.split('.').pop() || 'jpg' — an extension-less path yields
        // the whole path here (falsy only for the empty string).
        let ext = page_path.rsplit('.').next().unwrap_or("jpg");
        let ext = if ext.is_empty() { "jpg" } else { ext };
        Ok(format!("https://{server}/galleries/{media_id}/{page_number}.{ext}"))
    }

    /// getThumbnailUrl (:335-340).
    pub fn get_thumbnail_url(&self, _media_id: &str, thumb_path: &str) -> String {
        format!("https://t.nhentai.net/{thumb_path}")
    }

    /// getCoverUrl (:345-347).
    pub fn get_cover_url(&self, _media_id: &str, cover_path: &str) -> String {
        format!("https://t.nhentai.net/{cover_path}")
    }

    /// The cached config for a cache-hit read (no request); None when the
    /// cache is cold or expired.
    pub fn cdn_cached(&self) -> Option<CdnConfig> {
        self.cdn_config.clone()
    }

    /// Whether the /cdn cache is valid at `now` (1h window, :242).
    pub fn cdn_cache_valid(&self, now: i64) -> bool {
        self.cdn_config.is_some() && now - self.cdn_config_fetched_at < CDN_CACHE_MS
    }

    fn cached_cdn_config(&mut self, clock: &dyn Clock) -> Result<CdnConfig, String> {
        let now = clock.now_ms();
        if self.cdn_config.is_some() && now - self.cdn_config_fetched_at < CDN_CACHE_MS {
            return Ok(self.cdn_config.clone().expect("checked"));
        }
        let response = self.request(EndpointKey::Meta, "/cdn", "GET", None, clock)?;
        if let Some(resp) = &response {
            self.cdn_config = Some(
                serde_json::from_str::<CdnConfig>(&resp.body)
                    .map_err(|e| format!("failed to parse JSON: {e}"))?,
            );
            self.cdn_config_fetched_at = now;
        }
        self.cdn_config
            .clone()
            .ok_or_else(|| "API error: no cdn config".to_string())
    }
}

