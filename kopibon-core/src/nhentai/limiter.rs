//! rate-limiter.ts port — per-endpoint-group token buckets (04 §4).
//!
//! The TS drain loop maps onto a sequential blocking acquire here: Phase A's
//! consumer is single-threaded, and the single-pump invariant (waiters served
//! FIFO from one drain so N callers can't all fire at token renewal) is what
//! matters; it is trivially held by one caller and asserted by the pacing
//! tests. All arithmetic runs on an injected `Clock` — no wall clock reads.

use std::collections::BTreeMap;

use crate::metadata::mappers::Clock;

/// Token bucket (rate-limiter.ts:13-133).
#[derive(Debug, Clone)]
pub struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    /// tokens per millisecond
    refill_rate: f64,
    last_refill: i64,
}

impl RateLimiter {
    pub fn new(max_requests_per_minute: f64, now: i64) -> Self {
        let max_tokens = sanitize(max_requests_per_minute, 30.0);
        RateLimiter {
            tokens: max_tokens,
            max_tokens,
            refill_rate: max_tokens / 60_000.0,
            last_refill: now,
        }
    }

    fn refill(&mut self, now: i64) {
        let elapsed = now - self.last_refill;
        if elapsed <= 0 {
            return;
        }
        self.tokens = (self.tokens + elapsed as f64 * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;
    }

    /// tryAcquire (:96-103).
    pub fn try_acquire(&mut self, now: i64) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// The drain loop's wait for the next token (:84-86): max(10, ceil(deficit
    /// / rate)). Exposed so tests advance a fake clock by exactly this.
    pub fn wait_ms(&self) -> i64 {
        let deficit = 1.0 - self.tokens;
        let raw = (deficit / self.refill_rate).ceil() as i64;
        raw.max(10)
    }

    /// Blocking acquire — the sequential shape of the TS `acquire()` promise
    /// for a single consumer.
    pub fn acquire(&mut self, clock: &dyn Clock) {
        loop {
            let now = clock.now_ms();
            if self.try_acquire(now) {
                return;
            }
            let wait = self.wait_ms() as u64;
            std::thread::sleep(std::time::Duration::from_millis(wait));
        }
    }

    /// setRateLimit (:108-120): invalid values ignored; keeps tokens ≤ new
    /// max.
    pub fn set_rate_limit(&mut self, max_requests_per_minute: f64, now: i64) {
        let next = sanitize(max_requests_per_minute, self.max_tokens);
        self.refill(now);
        self.max_tokens = next;
        self.refill_rate = next / 60_000.0;
        self.tokens = self.tokens.min(next);
    }

    pub fn available_tokens(&mut self, now: i64) -> f64 {
        self.refill(now);
        self.tokens
    }

    pub fn limit(&self) -> f64 {
        self.max_tokens
    }
}

/// sanitize (:37-41): reject NaN/∞/≤0 with a fallback — a bad value once
/// poisoned the bucket so limiting silently stopped.
fn sanitize(value: f64, fallback: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        fallback
    } else {
        value
    }
}

/// Endpoint groups (rate-limiter.ts:141-153).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EndpointKey {
    Search,
    Galleries,
    Gallery,
    Popular,
    Related,
    Favorite,
    Favorites,
    User,
    Meta,
    TagsIds,
    TagsSearch,
}

impl EndpointKey {
    pub fn as_str(&self) -> &'static str {
        match self {
            EndpointKey::Search => "search",
            EndpointKey::Galleries => "galleries",
            EndpointKey::Gallery => "gallery",
            EndpointKey::Popular => "popular",
            EndpointKey::Related => "related",
            EndpointKey::Favorite => "favorite",
            EndpointKey::Favorites => "favorites",
            EndpointKey::User => "user",
            EndpointKey::Meta => "meta",
            EndpointKey::TagsIds => "tagsIds",
            EndpointKey::TagsSearch => "tagsSearch",
        }
    }

    pub fn all() -> [EndpointKey; 11] {
        [
            EndpointKey::Search,
            EndpointKey::Galleries,
            EndpointKey::Gallery,
            EndpointKey::Popular,
            EndpointKey::Related,
            EndpointKey::Favorite,
            EndpointKey::Favorites,
            EndpointKey::User,
            EndpointKey::Meta,
            EndpointKey::TagsIds,
            EndpointKey::TagsSearch,
        ]
    }

    fn limits(&self) -> (f64, f64) {
        // ENDPOINT_LIMITS table (:154-169), verbatim (anon, auth).
        match self {
            EndpointKey::Search => (10.0, 20.0),
            EndpointKey::Galleries => (15.0, 30.0),
            EndpointKey::Gallery => (20.0, 45.0),
            EndpointKey::Popular => (8.0, 8.0),
            EndpointKey::Related => (12.0, 30.0),
            EndpointKey::Favorite => (15.0, 15.0),
            EndpointKey::Favorites => (15.0, 15.0),
            EndpointKey::User => (45.0, 45.0),
            EndpointKey::Meta => (30.0, 30.0),
            EndpointKey::TagsIds => (15.0, 15.0),
            EndpointKey::TagsSearch => (30.0, 30.0),
        }
    }
}

/// The documented requests-per-minute for one endpoint group (:181-184).
/// The sync batch derives its pacing from this, never a constant.
pub fn endpoint_limit_per_minute(key: EndpointKey, authenticated: bool) -> f64 {
    let (anon, auth) = key.limits();
    if authenticated {
        auth
    } else {
        anon
    }
}

/// One bucket per endpoint group, swapping between anon and auth limit sets
/// (:190-239).
pub struct ApiRateLimiter {
    buckets: BTreeMap<EndpointKey, RateLimiter>,
    authenticated: bool,
}

impl ApiRateLimiter {
    pub fn new(authenticated: bool, now: i64) -> Self {
        let mut limiter = ApiRateLimiter {
            buckets: BTreeMap::new(),
            authenticated,
        };
        for key in EndpointKey::all() {
            limiter
                .buckets
                .insert(key, RateLimiter::new(endpoint_limit_per_minute(key, authenticated), now));
        }
        limiter
    }

    /// Switch every bucket between the anon and auth limit sets (:210-216).
    /// No-op when unchanged.
    pub fn set_authenticated(&mut self, authenticated: bool, now: i64) {
        if self.authenticated == authenticated {
            return;
        }
        self.authenticated = authenticated;
        for (key, bucket) in self.buckets.iter_mut() {
            bucket.set_rate_limit(endpoint_limit_per_minute(*key, authenticated), now);
        }
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    pub fn acquire(&mut self, key: EndpointKey, clock: &dyn Clock) {
        if let Some(bucket) = self.buckets.get_mut(&key) {
            bucket.acquire(clock);
        }
    }

    pub fn try_acquire(&mut self, key: EndpointKey, now: i64) -> bool {
        match self.buckets.get_mut(&key) {
            Some(bucket) => bucket.try_acquire(now),
            None => true,
        }
    }

    /// Diagnostics: current token count per endpoint group (:229-238).
    pub fn snapshot(&mut self, now: i64) -> BTreeMap<String, (i64, i64)> {
        let mut out = BTreeMap::new();
        for (key, bucket) in self.buckets.iter_mut() {
            out.insert(
                key.as_str().to_string(),
                (bucket.available_tokens(now).floor() as i64, bucket.limit() as i64),
            );
        }
        out
    }
}
