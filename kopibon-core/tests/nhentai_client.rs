//! WP-A7 — nhentai client port tests (04 §7): limiter arithmetic on a fake
//! clock, request-identical endpoint parity on a replay transport, both 429
//! retry models, and the tag resolver's caps and stop-on-failure semantics.

mod common;

#[allow(unused_imports)]
use kopibon_core::nhentai::tags::{TagCacheStore, TagsClient};

use kopibon_core::metadata::mappers::{Clock, FixedClock};
use kopibon_core::nhentai::http::{RequestDef, ResponseDef, Transport};
use kopibon_core::nhentai::limiter::{
    endpoint_limit_per_minute, ApiRateLimiter, EndpointKey, RateLimiter,
};
use kopibon_core::nhentai::sync_fetch::{fetch_gallery, AttemptOutcome};
use kopibon_core::nhentai::{ApiClient, CdnConfig};

/// Records requests, answers from a script, and tracks the last request.
struct ReplayTransport {
    responses: Vec<ResponseDef>,
    pub requests: Vec<RequestDef>,
}

impl ReplayTransport {
    fn new(responses: Vec<ResponseDef>) -> Self {
        ReplayTransport {
            responses,
            requests: Vec::new(),
        }
    }
    fn ok(body: &str) -> ResponseDef {
        ResponseDef {
            status: 200,
            status_text: "OK".into(),
            headers: vec![],
            body: body.to_string(),
        }
    }
    fn error(status: u16, text: &str, retry_after: Option<&str>) -> ResponseDef {
        ResponseDef {
            status,
            status_text: text.into(),
            headers: retry_after
                .map(|v| vec![("Retry-After".to_string(), v.to_string())])
                .unwrap_or_default(),
            body: String::new(),
        }
    }
}

/// Shared wrapper with interior mutability for recording.
struct SharedTransport(std::sync::Mutex<ReplayTransport>);

impl Transport for SharedTransport {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        let mut inner = self.0.lock().expect("lock");
        inner.requests.push(request.clone());
        if inner.responses.is_empty() {
            return Err("no scripted response".to_string());
        }
        Ok(inner.responses.remove(0))
    }
}

impl SharedTransport {
    fn new(responses: Vec<ResponseDef>) -> Self {
        SharedTransport(std::sync::Mutex::new(ReplayTransport::new(responses)))
    }
    fn requests(&self) -> Vec<RequestDef> {
        self.0.lock().expect("lock").requests.clone()
    }
}

fn client(transport: SharedTransport) -> ApiClient<SharedTransport> {
    ApiClient::new(transport, false, 1_000_000)
}

fn last_request(client: &ApiClient<SharedTransport>) -> RequestDef {
    client
        .transport
        .requests()
        .last()
        .expect("a request was sent")
        .clone()
}

// ─── Limiter (fake clock) ────────────────────────────────────────────────────

#[test]
fn limiter_refill_arithmetic_and_cap() {
    let now = 1_000_000;
    let mut bucket = RateLimiter::new(10.0, now);
    assert_eq!(bucket.limit(), 10.0);
    // 10 instant acquires, the 11th must wait a full token interval.
    let mut acquired = 0;
    for _ in 0..10 {
        if bucket.try_acquire(now) {
            acquired += 1;
        }
    }
    assert_eq!(acquired, 10);
    assert!(!bucket.try_acquire(now), "bucket empty at t");
    assert_eq!(bucket.wait_ms(), 6000, "60000/10 tokens per minute");
    // Half a token interval refills half a token → still not enough.
    assert!(!bucket.try_acquire(now + 3000));
    assert!(bucket.try_acquire(now + 6000), "a full token after 6s");
    // Cap: tokens never exceed max after a long idle.
    assert_eq!(bucket.available_tokens(now + 3_600_000), 10.0);
}

#[test]
fn limiter_sanitize_fallbacks() {
    let now = 0;
    // Bad values fall back to 30 (the constructor default).
    assert_eq!(RateLimiter::new(f64::NAN, now).limit(), 30.0);
    assert_eq!(RateLimiter::new(0.0, now).limit(), 30.0);
    assert_eq!(RateLimiter::new(-5.0, now).limit(), 30.0);
    assert_eq!(RateLimiter::new(f64::INFINITY, now).limit(), 30.0);

    // setRateLimit ignores invalid values and keeps tokens <= new max.
    let mut bucket = RateLimiter::new(10.0, now);
    let _ = bucket.try_acquire(now);
    bucket.set_rate_limit(f64::NAN, now);
    assert_eq!(bucket.limit(), 10.0, "invalid value ignored");
    bucket.set_rate_limit(2.0, now);
    assert_eq!(bucket.limit(), 2.0);
    assert!(bucket.available_tokens(now) <= 2.0, "tokens capped at new max");
    assert_eq!(bucket.wait_ms(), 10, "minimum wait is 10ms");
}

#[test]
fn limiter_endpoint_table_and_tier_swap() {
    // ENDPOINT_LIMITS verbatim (anon, auth).
    let cases = [
        (EndpointKey::Search, (10, 20)),
        (EndpointKey::Galleries, (15, 30)),
        (EndpointKey::Gallery, (20, 45)),
        (EndpointKey::Popular, (8, 8)),
        (EndpointKey::Related, (12, 30)),
        (EndpointKey::Favorite, (15, 15)),
        (EndpointKey::Favorites, (15, 15)),
        (EndpointKey::User, (45, 45)),
        (EndpointKey::Meta, (30, 30)),
        (EndpointKey::TagsIds, (15, 15)),
        (EndpointKey::TagsSearch, (30, 30)),
    ];
    for (key, (anon, auth)) in cases {
        assert_eq!(endpoint_limit_per_minute(key, false) as i64, anon, "{key:?} anon");
        assert_eq!(endpoint_limit_per_minute(key, true) as i64, auth, "{key:?} auth");
    }

    let now = 5_000_000;
    let mut limiter = ApiRateLimiter::new(false, now);
    let snap = limiter.snapshot(now);
    assert_eq!(snap["search"], (10, 10));
    assert_eq!(snap["popular"], (8, 8));
    // Tier swap: same instance, auth limits.
    limiter.set_authenticated(true, now);
    assert!(limiter.is_authenticated());
    let snap = limiter.snapshot(now);
    assert_eq!(snap["search"], (10, 20));
    assert_eq!(snap["popular"], (8, 8));
    // No-op swap must not reset buckets.
    limiter.set_authenticated(true, now);
    let snap = limiter.snapshot(now);
    assert_eq!(snap["search"], (10, 20));
}

#[test]
fn limiter_never_exceeds_10_per_minute_scripted() {
    // 25 scripted search calls on a fake clock: no 60s window may contain
    // more than 10 acquires.
    let now = 0;
    let mut bucket = RateLimiter::new(10.0, now);
    let mut events: Vec<i64> = Vec::new();
    let mut t = now;
    for _ in 0..25 {
        loop {
            if bucket.try_acquire(t) {
                events.push(t);
                break;
            }
            t += bucket.wait_ms();
        }
    }
    // Token-bucket semantics: a full burst up front, then every subsequent
    // acquire paces at exactly the refill interval (60000/limit ms).
    let gaps: Vec<i64> = events.windows(2).map(|w| w[1] - w[0]).collect();
    assert_eq!(gaps.iter().filter(|&&g| g == 0).count(), 9, "10-token burst at t=0");
    for &g in gaps.iter().skip(9) {
        assert_eq!(g, 6000, "refill pacing = 60000/10 ms");
    }
    assert_eq!(*events.last().expect("events"), 15 * 6000, "25 calls take 15 refill intervals");
}

// ─── Endpoint request parity (replay transport) ─────────────────────────────

#[test]
fn endpoint_requests_are_identical() {
    let clock = FixedClock(1_700_000_000_000);
    // Anonymous search: UA + Accept, no Authorization; sort=date omitted.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("{}")]));
    let _ = c.search_galleries("big breasts", Some(2), Some("date"), &clock).unwrap();
    let req = last_request(&c);
    assert_eq!(req.method, "GET");
    assert_eq!(req.url, "https://nhentai.net/api/v2/search?query=big+breasts&page=2");
    assert_eq!(req.headers[0], ("User-Agent".into(), "Doujin-Downloader/1.0".into()));
    assert_eq!(req.headers[1], ("Accept".into(), "application/json".into()));
    assert!(!req.headers.iter().any(|(k, _)| k == "Authorization"));

    // sort non-date is sent; page 0 is falsy and omitted.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("{}")]));
    let _ = c.search_galleries("x", Some(0), Some("popular-today"), &clock).unwrap();
    assert_eq!(
        last_request(&c).url,
        "https://nhentai.net/api/v2/search?query=x&sort=popular-today"
    );

    // gallery with key: ?include=favorite + Authorization header.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("{}")]));
    c.set_api_key(Some("sekrit"), clock.now_ms());
    let _ = c.get_gallery(1234, &clock).unwrap();
    let req = last_request(&c);
    assert_eq!(req.url, "https://nhentai.net/api/v2/galleries/1234?include=favorite");
    assert!(req.headers.iter().any(|(k, v)| k == "Authorization" && v == "Key sekrit"));

    // gallery without key: no query.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("{}")]));
    let _ = c.get_gallery(1234, &clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/galleries/1234");

    // favorites uses `q`.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("{}")]));
    let _ = c.get_favorites(3, Some("artist:x"), &clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/favorites?page=3&q=artist%3Ax");

    // popular returns a bare array (transport just carries the body).
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("[]")]));
    let _ = c.get_popular_galleries(&clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/galleries/popular");

    // latest galleries + related.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::ok("{}"),
        ReplayTransport::ok("{}"),
    ]));
    let _ = c.get_latest_galleries(7, &clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/galleries?page=7");
    let _ = c.get_related_galleries(9, &clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/galleries/9/related");

    // tagsIds: dedup + positive filter, joined.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("[]")]));
    let _ = c.get_tags_by_ids(&[5, 3, 5, 0, -2, 7], &clock).unwrap();
    assert_eq!(last_request(&c).url, "https://nhentai.net/api/v2/tags/ids?ids=5,3,7");

    // tagsIds cap.
    let mut c = client(SharedTransport::new(vec![]));
    let ids: Vec<i64> = (1..=101).collect();
    let err = c.get_tags_by_ids(&ids, &clock).unwrap_err();
    assert_eq!(err, "getTagsByIds accepts at most 100 ids, got 101");

    // tagsSearch body: query, type, limit in insertion order.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("[]")]));
    let _ = c.search_tags("  breath  ", None, None, &clock).unwrap();
    let req = last_request(&c);
    assert_eq!(req.method, "POST");
    assert_eq!(req.url, "https://nhentai.net/api/v2/tags/search");
    assert_eq!(req.body.as_deref(), Some(r#"{"query":"breath","type":null,"limit":10}"#));
    assert!(req.headers.iter().any(|(k, v)| k == "Content-Type" && v == "application/json"));
    let mut c = client(SharedTransport::new(vec![ReplayTransport::ok("[]")]));
    let _ = c.search_tags("x", Some("artist"), Some(999), &clock).unwrap();
    assert_eq!(
        last_request(&c).body.as_deref(),
        Some(r#"{"query":"x","type":"artist","limit":50}"#)
    );

    // favorite POST/DELETE.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::error(204, "No Content", None),
        ReplayTransport::error(204, "No Content", None),
    ]));
    let _ = c.add_favorite(42, &clock).unwrap();
    assert_eq!(last_request(&c).method, "POST");
    let _ = c.remove_favorite(42, &clock).unwrap();
    assert_eq!(last_request(&c).method, "DELETE");

    // URL builders.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::ok(
            r#"{"image_servers":["i2.nhentai.net","i5.nhentai.net"],"thumb_servers":["t2.nhentai.net"]}"#,
        ),
        ReplayTransport::ok(
            r#"{"image_servers":["i2.nhentai.net","i5.nhentai.net"],"thumb_servers":["t2.nhentai.net"]}"#,
        ),
    ]));
    let url = c.get_image_url("123456", 3, "04.jpg", &clock).unwrap();
    assert_eq!(url, "https://i2.nhentai.net/galleries/123456/3.jpg");
    assert_eq!(c.get_thumbnail_url("1", "galleries/1/thumb.jpg"), "https://t.nhentai.net/galleries/1/thumb.jpg");
    assert_eq!(c.get_cover_url("1", "galleries/1/cover.jpg"), "https://t.nhentai.net/galleries/1/cover.jpg");

    // CDN cache: second call within the hour sends nothing new.
    let count_before = c.transport.requests().len();
    let url2 = c.get_image_url("123456", 4, "05.jpg", &clock).unwrap();
    assert_eq!(url2, "https://i2.nhentai.net/galleries/123456/4.jpg");
    assert_eq!(c.transport.requests().len(), count_before, "cdn cache hit");
    // After the hour the cache expires.
    let later = FixedClock(clock.0 + 3_600_000);
    let _ = c.get_image_url("123456", 5, "06.jpg", &later).unwrap();
    assert!(c.transport.requests().len() > count_before, "cdn cache expired");
}

#[test]
fn typed_responses_round_trip() {
    // The response types must parse captured-shape bodies without loss.
    let body = r#"{
        "result": [{
            "id": 1, "media_id": "123", "english_title": "T", "japanese_title": null,
            "thumbnail": "x.jpg", "thumbnail_width": 100, "thumbnail_height": 140,
            "num_pages": 20, "num_favorites": 5, "tag_ids": [1,2], "blacklisted": true
        }],
        "num_pages": 9, "per_page": 25, "total": null
    }"#;
    let parsed: kopibon_core::nhentai::SearchResponse = serde_json::from_str(body).expect("parse");
    assert_eq!(parsed.result.len(), 1);
    assert_eq!(parsed.result[0].media_id, "123");
    assert!(parsed.result[0].blacklisted);
    assert_eq!(parsed.total, None);

    let detail_body = r#"{
        "id": 7, "media_id": "9", "title": {"english": "E", "japanese": null, "pretty": "P"},
        "cover": {"path": "c.jpg", "width": 1, "height": 2},
        "thumbnail": {"path": "t.jpg", "width": 1, "height": 2}, "scanlator": "",
        "upload_date": 1600000000, "tags": [{"id": 3, "type": "tag", "name": "n", "slug": "n", "url": "/tag/n", "count": 4}],
        "num_pages": 2, "num_favorites": 0, "pages": []
    }"#;
    let detail: kopibon_core::nhentai::GalleryDetail = serde_json::from_str(detail_body).expect("parse");
    assert_eq!(detail.title.pretty, "P");
    assert_eq!(detail.tags[0].tag_type, "tag");
    assert_eq!(detail.is_favorited, None);

    let config: CdnConfig = serde_json::from_str(
        r#"{"image_servers":["i.nhentai.net"],"thumb_servers":["t.nhentai.net"]}"#,
    )
    .expect("parse");
    assert_eq!(config.image_servers.len(), 1);
}

// ─── The two 429 retry models ────────────────────────────────────────────────

#[test]
fn client_429_retry_once_with_retry_after() {
    let clock = FixedClock(1_000_000);
    // 429 with Retry-After: 2 → 2000ms wait, one retry, then success.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", Some("2")),
        ReplayTransport::ok(r#"{"result":[]}"#),
    ]));
    let waits = std::sync::Arc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let waits_c = waits.clone();
    c.sleep = Box::new(move |ms| waits_c.lock().unwrap().push(ms));
    let resp = c.search_galleries("x", None, None, &clock).expect("recovered");
    assert_eq!(waits.lock().unwrap().as_slice(), &[2000]);
    assert_eq!(c.transport.requests().len(), 2, "exactly one retry");
    let _ = resp;

    // Without the header → default 5000.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", None),
        ReplayTransport::ok("{}"),
    ]));
    let waits = std::sync::Arc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let waits_c = waits.clone();
    c.sleep = Box::new(move |ms| waits_c.lock().unwrap().push(ms));
    let _ = c.get_gallery(1, &clock).unwrap();
    assert_eq!(waits.lock().unwrap().as_slice(), &[5000]);

    // Retry-After above the cap → 60000.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", Some("100")),
        ReplayTransport::ok("{}"),
    ]));
    let waits = std::sync::Arc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let waits_c = waits.clone();
    c.sleep = Box::new(move |ms| waits_c.lock().unwrap().push(ms));
    let _ = c.get_gallery(1, &clock).unwrap();
    assert_eq!(waits.lock().unwrap().as_slice(), &[60000]);

    // A second 429 on the retry is an error: `API error: 429 Too Many Requests`.
    let mut c = client(SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", Some("1")),
        ReplayTransport::error(429, "Too Many Requests", Some("1")),
    ]));
    c.sleep = Box::new(|_| {});
    let err = c.get_gallery(1, &clock).unwrap_err();
    assert_eq!(err, "API error: 429 Too Many Requests");

    // Non-429 errors are immediate and verbatim.
    let mut c = client(SharedTransport::new(vec![ReplayTransport::error(
        500, "Internal Server Error", None,
    )]));
    c.sleep = Box::new(|_| {});
    let err = c.get_user(&clock).unwrap_err();
    assert_eq!(err, "API error: 500 Internal Server Error");
    assert_eq!(c.transport.requests().len(), 1, "no retry on non-429");
}

#[test]
fn sync_fetch_three_attempt_model() {

    // Success on the first attempt.
    let t = SharedTransport::new(vec![ReplayTransport::ok(r#"{"id":1}"#)]);
    let (result, outcomes) = fetch_gallery(&t, 1, Some("k"), 0, &mut |_| {});
    assert!(result.is_ok());
    assert_eq!(outcomes, vec![AttemptOutcome::Success]);
    let req = &t.requests()[0];
    // The OTHER UA string, no Accept header.
    assert_eq!(req.headers[0], ("User-Agent".into(), "DoujinDownloader/1.0 (eN7ityy)".into()));
    assert!(req.headers.iter().any(|(k, v)| k == "Authorization" && v == "Key k"));
    assert_eq!(req.url, "https://nhentai.net/api/v2/galleries/1");

    // Anonymous: no Authorization.
    let t = SharedTransport::new(vec![ReplayTransport::ok("{}")]);
    let _ = fetch_gallery(&t, 2, None, 0, &mut |_| {});
    assert!(!t.requests()[0].headers.iter().any(|(k, _)| k == "Authorization"));

    // 429: Retry-After 7 + 250ms jitter → 7250ms, then success.
    let waits = std::rc::Rc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let t = SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", Some("7")),
        ReplayTransport::ok("{}"),
    ]);
    let (_, outcomes) = fetch_gallery(&t, 3, None, 250, &mut |ms| waits.lock().unwrap().push(ms));
    assert_eq!(waits.lock().unwrap().as_slice(), &[7250]);
    assert_eq!(outcomes, vec![AttemptOutcome::RateLimited, AttemptOutcome::Success]);

    // 429 without a header → default 5s + jitter.
    let waits = std::rc::Rc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let t = SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", None),
        ReplayTransport::ok("{}"),
    ]);
    let _ = fetch_gallery(&t, 3, None, 100, &mut |ms| waits.lock().unwrap().push(ms));
    assert_eq!(waits.lock().unwrap().as_slice(), &[5100]);

    // HTTP 500 → backoff 2000 + attempt*1000, error string verbatim.
    let waits = std::rc::Rc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let t = SharedTransport::new(vec![
        ReplayTransport::error(500, "Internal Server Error", None),
        ReplayTransport::ok("{}"),
    ]);
    let (_, outcomes) = fetch_gallery(&t, 4, None, 0, &mut |ms| waits.lock().unwrap().push(ms));
    assert_eq!(waits.lock().unwrap().as_slice(), &[3000]);
    assert_eq!(
        outcomes,
        vec![
            AttemptOutcome::Failed {
                error: "HTTP 500: Internal Server Error".into()
            },
            AttemptOutcome::Success
        ]
    );

    // Three 429s exhaust the loop (continue consumes the attempt) → the
    // fallback error; no 2000ms backoff after a 429.
    let waits = std::rc::Rc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let t = SharedTransport::new(vec![
        ReplayTransport::error(429, "Too Many Requests", Some("1")),
        ReplayTransport::error(429, "Too Many Requests", Some("1")),
        ReplayTransport::error(429, "Too Many Requests", Some("1")),
    ]);
    let (result, _) = fetch_gallery(&t, 5, None, 0, &mut |ms| waits.lock().unwrap().push(ms));
    assert_eq!(
        result.unwrap_err(),
        "Failed to fetch gallery 5 after 3 retries"
    );
    assert_eq!(waits.lock().unwrap().as_slice(), &[1000, 1000, 1000]);

    // Three hard failures → 2000+3000 waits, last error rethrown.
    let waits = std::rc::Rc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let t = SharedTransport::new(vec![
        ReplayTransport::error(500, "E1", None),
        ReplayTransport::error(502, "E2", None),
        ReplayTransport::error(503, "E3", None),
    ]);
    let (result, _) = fetch_gallery(&t, 6, None, 0, &mut |ms| waits.lock().unwrap().push(ms));
    assert_eq!(result.unwrap_err(), "HTTP 503: E3");
    assert_eq!(waits.lock().unwrap().as_slice(), &[3000, 4000]);
}

// ─── Tag resolver (04 §6) ────────────────────────────────────────────────────

struct MapStore {
    rows: std::sync::Mutex<std::collections::HashMap<i64, (String, String)>>,
}
impl MapStore {
    fn new() -> Self {
        MapStore {
            rows: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}
impl kopibon_core::nhentai::tags::TagCacheStore for MapStore {
    fn find_by_ids(&self, ids: &[i64]) -> Vec<(i64, String, String)> {
        let rows = self.rows.lock().unwrap();
        ids.iter()
            .filter_map(|id| rows.get(id).map(|(t, n)| (*id, t.clone(), n.clone())))
            .collect()
    }
    fn upsert_many(&self, tags: &[(i64, String, String)], _now: i64) {
        let mut rows = self.rows.lock().unwrap();
        for (id, t, n) in tags {
            if *id == 0 || n.is_empty() {
                continue;
            }
            rows.insert(*id, (t.clone(), n.clone()));
        }
    }
}

/// One scripted getTagsByIds answer.
type ScriptedTags = Result<Vec<(i64, String, String)>, String>;

struct FailingTagsClient {
    responses: Vec<ScriptedTags>,
    pub calls: Vec<Vec<i64>>,
}
impl kopibon_core::nhentai::tags::TagsClient for FailingTagsClient {
    fn get_tags_by_ids(&mut self, ids: &[i64]) -> Result<Vec<(i64, String, String)>, String> {
        self.calls.push(ids.to_vec());
        self.responses.remove(0)
    }
}

#[test]
fn tag_resolver_cache_first_and_caps() {
    let clock = FixedClock(0);
    // Cold cache, 250 missing ids: capped at 3 batches of 100; the 4th is
    // left for a later call.
    let mut store = MapStore::new();
    let mut client = FailingTagsClient {
        responses: (0..3)
            .map(|i| {
                Ok((i * 100 + 1..=i * 100 + 100)
                    .map(|id| (id, "tag".to_string(), format!("tag{id}")))
                    .collect())
            })
            .collect(),
        calls: Vec::new(),
    };
    let ids: Vec<i64> = (1..=250).collect();
    let resolved = kopibon_core::nhentai::tags::resolve_tag_names(&mut store, &mut client, &ids, &clock);
    assert_eq!(client.calls.len(), 3, "MAX_BATCHES_PER_CALL = 3");
    assert_eq!(client.calls[0].len(), 100);
    assert_eq!(resolved.len(), 300, "ids 1..=300 resolved");
    assert!(!resolved.contains_key(&301), "the remainder degrades to not-yet");

    // Cache-first: ids already cached never hit the client.
    let mut store = MapStore::new();
    store
        .rows
        .lock()
        .unwrap()
        .insert(7, ("tag".into(), "cached".into()));
    let mut client = FailingTagsClient {
        responses: vec![],
        calls: Vec::new(),
    };
    let resolved = kopibon_core::nhentai::tags::resolve_tag_names(&mut store, &mut client, &[7, 7], &clock);
    assert!(client.calls.is_empty(), "no network for cached ids");
    assert_eq!(resolved.get(&7).expect("hit").name, "cached");

    // Dedup: repeated ids collapse into one batch.
    let mut store = MapStore::new();
    let mut client = FailingTagsClient {
        responses: vec![Ok(vec![(5, "tag".into(), "five".into())])],
        calls: Vec::new(),
    };
    let resolved = kopibon_core::nhentai::tags::resolve_tag_names(&mut store, &mut client, &[5, 5, 5], &clock);
    assert_eq!(client.calls, vec![vec![5]]);
    assert_eq!(resolved.len(), 1);

    // Stop-on-failure: a failed batch stops the call and keeps what resolved.
    let mut store = MapStore::new();
    store
        .rows
        .lock()
        .unwrap()
        .insert(1, ("tag".into(), "one".into()));
    let mut client = FailingTagsClient {
        responses: vec![Err("API error: 429 Too Many Requests".into())],
        calls: Vec::new(),
    };
    let resolved = kopibon_core::nhentai::tags::resolve_tag_names(&mut store, &mut client, &[1, 2, 3], &clock);
    assert_eq!(client.calls.len(), 1, "stopped after the failed batch");
    assert_eq!(resolved.len(), 1, "kept what resolved");
    assert_eq!(resolved.get(&1).expect("hit").name, "one");

    // resolveGalleryTags: one pass over every gallery's ids.
    let mut store = MapStore::new();
    let mut client = FailingTagsClient {
        responses: vec![Ok(vec![
            (10, "tag".into(), "shared".into()),
            (11, "artist".into(), "a".into()),
        ])],
        calls: Vec::new(),
    };
    let by_gallery = kopibon_core::nhentai::tags::resolve_gallery_tags(
        &mut store,
        &mut client,
        &[(1, vec![10, 11]), (2, vec![10])],
        &clock,
    );
    assert_eq!(client.calls.len(), 1, "ids resolve once for the page");
    assert_eq!(by_gallery[&1].len(), 2);
    assert_eq!(by_gallery[&2].len(), 1);

    // Empty result = not known yet, never an error: bad ids filtered out.
    let mut store = MapStore::new();
    let mut client = FailingTagsClient {
        responses: vec![],
        calls: Vec::new(),
    };
    let resolved = kopibon_core::nhentai::tags::resolve_tag_names(&mut store, &mut client, &[0, -3], &clock);
    assert!(resolved.is_empty());
    assert!(client.calls.is_empty());
}

#[test]
fn tag_cache_sqlite_store_round_trip() {
    let dir = std::env::temp_dir().join(format!("tagcache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).expect("db");
    let clock = FixedClock(1_234_567);

    db.with_writer(|c| {
        let store = kopibon_core::nhentai::tags::SqliteTagCache { conn: c };
        // id 0 and empty names are skipped (poison guard).
        store.upsert_many(
            &[
                (5, "tag".into(), "five".into()),
                (0, "tag".into(), "zero".into()),
                (6, "".into(), "typed".into()),
            ],
            clock.now_ms(),
        );
        Ok(())
    })
    .expect("upsert");

    let rows = db.with_writer(|c| {
        let store = kopibon_core::nhentai::tags::SqliteTagCache { conn: c };
        Ok(store.find_by_ids(&[5, 6, 7]))
    });
    let rows: Vec<(i64, String, String)> = rows.expect("find");
    assert_eq!(rows.len(), 2, "zero-id row skipped");
    assert!(rows.contains(&(5, "tag".into(), "five".into())));
    assert!(rows.contains(&(6, "tag".into(), "typed".into())), "empty type falls back to 'tag'");

    // Upsert overwrites.
    db.with_writer(|c| {
        let store = kopibon_core::nhentai::tags::SqliteTagCache { conn: c };
        store.upsert_many(&[(5, "parody".into(), "renamed".into())], clock.now_ms());
        Ok(())
    })
    .expect("re-upsert");
    let rows = db
        .with_writer(|c| Ok(kopibon_core::nhentai::tags::SqliteTagCache { conn: c }.find_by_ids(&[5])))
        .expect("find");
    assert_eq!(rows, vec![(5, "parody".into(), "renamed".into())]);
    std::fs::remove_dir_all(&dir).ok();
}
