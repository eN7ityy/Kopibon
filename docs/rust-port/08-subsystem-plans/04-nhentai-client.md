# Subsystem plan 04 — nhentai client (`kopibon-core::nhentai`)

Execution plan for the Rust port of `src/main/services/api-client.ts` (358),
`rate-limiter.ts` (239), `tag-resolver.ts` (103) and `search-query.ts` (185),
built headless in Phase A. Toolkit-independent per
[06-technology-decision.md](../06-technology-decision.md) §8 ("reqwest port of
`api-client.ts` + rate limiter"). Related consumers:
[03-download-manager.md](03-download-manager.md) (gallery + CDN fetch, page
downloads), the sync flow (01-current-architecture §3c), and the search/tag
UI surfaces via IPC ([02-ipc-surface.md](../02-ipc-surface.md)).

---

## 1. Module boundaries

```
kopibon-core/src/nhentai/
├── mod.rs        // ApiClient facade + auth state
├── http.rs       // HttpTransport trait; ReqwestTransport; test replay transport (§7)
├── types.rs      // GalleryDetail, SearchResponse, TagResponse, CdnConfig, ... (src/main/services/api-client.ts:5-123)
├── limiter.rs    // RateLimiter + ApiRateLimiter port (§4)
├── tags.rs       // tag resolver over tag_cache (§6)
├── query.rs      // search-query.ts port: pure syntax (§5)
└── sync_fetch.rs // the 3-attempt Retry-After fetch used by sync (§4.3)
```

`query.rs` and `limiter.rs` are pure (no I/O) and fully unit-testable;
`http.rs` is the only place that touches the network. The DB-facing half of
the tags resolver lives behind a small `TagCacheStore` trait so Phase A tests
need no SQLite. **`sync_fetch` exists separately because 1.x has two retry
models** (the client's single 429 retry and the sync worker's 3-attempt loop)
— port both, do not merge them (§4.3).

## 2. Endpoints (port all; none may be dropped)

Base `https://nhentai.net/api/v2` (src/main/services/api-client.ts:126). All from
`src/main/services/api-client.ts`:

| Method | Endpoint group (`EndpointKey`, src/main/services/rate-limiter.ts:141-153) | Cite / notes |
|---|---|---|
| GET `/search?query&page&sort` | `search` | :209-219; `sort` omitted when `date` |
| GET `/galleries?page` | `galleries` | :221-225 |
| GET `/galleries/popular` | `popular` | :227-230; returns a bare array wrapped into `{result}` |
| GET `/galleries/{id}` (+`?include=favorite` **only with a key**) | `gallery` | :232-238 |
| GET `/cdn` | `meta` | :240-249; **client cache 3 600 000 ms** (:242) |
| GET `/config` | `meta` | :251-253 |
| GET `/user` | `user` | :255-257 |
| GET `/favorites?page&q` | `favorites` | :259-265; note `q`, not `query` (:263) |
| GET `/galleries/{id}/related` | `related` | :267-269 |
| GET `/tags/ids?ids=1,2,…` | `tagsIds` | :279-286; **max 100 ids**, dedup + positive-int filter client-side |
| POST `/tags/search` `{query, type?, limit?}` | `tagsSearch` | :295-311; limit clamped 1–50, `type: null` searches all types |
| POST/DELETE `/galleries/{id}/favorite` | `favorite` | :313-319; 204 → no body (:202-205) |

Headers (:157-166): `User-Agent: Doujin-Downloader/1.0`, `Accept:
application/json`, `Authorization: Key {apiKey}` when a key is set. URL
builders: image
`https://{first image server}/galleries/{mediaId}/{n}.{ext}` (:324-330),
thumbnail/cover `https://t.nhentai.net/{path}` (:335-347).

**CDN server list handling:** `/cdn` returns `{image_servers, thumb_servers}`
(:82-85) cached for one hour. The client exposes the config; the *download
manager* owns rotation/demotion (its `orderServers` is the smart one —
[01-current-architecture.md](../01-current-architecture.md) §3a,
[03-download-manager.md](03-download-manager.md) §5). `getImageUrl` uses only
the first server (:324-330) — port it for API shape parity but do not let new
code rely on it; rotation belongs to the consumer.

## 3. HTTP stack — reqwest (decided)

**Decision: `reqwest` (rustls-tls) over `ureq`.** Justification: the corpus's
runtime shape is one shared `tokio` runtime
([06-technology-decision.md](../06-technology-decision.md) §1 item 2, §8) that
also hosts the download pipeline, scanner and queue pumps; `reqwest` joins it
directly, gives streaming bodies for page downloads, per-request timeouts
(matching the 30 s page timeout, src/main/services/download-manager.ts:791) and connection
pooling across the limiter's bursts. `ureq` is synchronous — adopting it would
fork a second threading model or force blocking calls inside the scheduler,
and the 429 waiter paths (§4) are naturally async. No `backoff`/`governor`
crate: the limiter and retry timings are behavioural contracts of 1.x and are
hand-rolled to match exactly (§4). All JSON via `serde` with the field-for-
field types of src/main/services/api-client.ts:5-123 (serde defaults where the API omits
fields — mirror TS's `undefined` handling rather than inventing nulls).

## 4. Rate limiting and retries (limiter.rs)

### 4.1 Token bucket (src/main/services/rate-limiter.ts:13-133)

Per-endpoint-group bucket, refilled continuously at `max/60_000` tokens/ms,
FIFO waiters served from **one drain loop** so N waiters can't each fire at
token-renewal (:60-90 — the comment documents the burst bug); `tryAcquire`
(:96-103); `sanitize` rejects NaN/∞/≤0 with a fallback (:37-41 — a bad value
once poisoned the bucket so limiting silently stopped); `setRateLimit` keeps
tokens ≤ new max and re-drains waiters (:108-120). Port with an injected
`Clock` (tests advance time); the drain loop becomes a `tokio` task or
`Notify`-driven queue with the same single-pump invariant.

### 4.2 Per-endpoint limits + auth tiers (src/main/services/rate-limiter.ts:135-239)

`ENDPOINT_LIMITS` table ported verbatim (:154-169): search 10/20,
galleries 15/30, gallery 20/45, popular 8/8, related 12/30, favorite 15/15,
favorites 15/15, user 45/45, meta 30/30, tagsIds 15/15, tagsSearch 30/30
(anon/auth per minute; values from the OpenAPI spec). `ApiRateLimiter` holds
one bucket per group and swaps the whole set on `setAuthenticated`
(:190-239); `snapshot()` feeds the renderer's rate-limit countdown
(src/main/services/api-client.ts:153-155). `endpointLimitPerMinute` (:181-184) stays a public
function — **the sync batch derives its pacing from it**, not from a constant
(01-current-architecture §3c: target = 90 % of the limit, interval =
`ceil(60000/target)`, sleep only the remainder of the interval; the old flat
3 s was the anonymous rate and made a key worthless).

### 4.3 Retry models — two, kept separate

- **Client (src/main/services/api-client.ts:189-196):** on 429 read `Retry-After` (seconds);
  wait `min(retryAfter·1000, 60_000)` (default 5 000 when absent/invalid),
  re-acquire a token, **retry once**. Any other non-OK → error
  `API error: {status} {statusText}`.
- **Sync fetch (src/main/services/sync.worker.ts:39-80):** 3 attempts; a 429 honours
  `Retry-After` (default 5) + up to 1 s jitter and does **not** consume an
  attempt (:52-59); other failures wait `2000 + attempt·1000` ms (:74) and do;
  every attempt is logged (:72). Note its UA is the *other* string,
  `DoujinDownloader/1.0 (eN7ityy)` (:44) — preserve verbatim; the fixtures
  assert both.

## 5. Query composition (query.rs) — pure syntax

Port `search-query.ts` in full; it is deliberately Electron/DB/network-free
and is the diff-tested surface (header comment :1-12; syntax keywords,
quoting, negation):

- `quoteIfNeeded` (:51-54): quote only on whitespace; embedded `"` **stripped**,
  never escaped (no documented escape in the syntax).
- `negationTerm` (:57-62): `-value` for `text`, `-{type}:{value}` otherwise;
  null when the cleaned value is empty.
- `queryHasField` (:74-76): term-boundary `(^|\s)-?{field}:` case-insensitive —
  a default never overrides what the user typed.
- `buildSearchQuery` (:87-134): user terms first (or `defaultQuery` only when
  nothing typed), then defaults — `language:` (unless present), `pages:>N`,
  `favorites:>=N`, `uploaded:<Nd` (each gated the same way) — then `exclude`
  negations deduped case-insensitively (:121-131). **`dim` entries never
  become negations** (:123) — dimming means the gallery still arrives.
- `matchDimEntries` (:163-185): `text` = case-insensitive substring of the
  title; every other type = **exact, case-insensitive, whole-name** match
  against resolved tags (substring tag matching would make "rape" catch
  "grape", :159-161); returns every match so the UI can say *why*; missing tag
  types are absent, not empty. Consumes `tags::resolveGalleryTags` output.

## 6. Tags cache (tags.rs)

`tag_cache` table (03-data-model §2.12; repo methods
src/main/db/repositories/tag-cache.repo.ts:18-70: `findByIds`, `missingIds`,
`upsertMany`). Port `tag-resolver.ts` exactly:

- Cache-first `resolveTagNames` (:34-79): dedup + positive-int filter, look up
  `tag_cache`, batch the missing into **100-id** batches (the documented
  `/tags/ids` maximum, :8), fetch at most **`MAX_BATCHES_PER_CALL = 3`**
  batches per call (:20) — the endpoint is 15/min and a cold cache on a page
  of results can exceed it; the remainder resolves on later calls and dim mode
  degrades to "not dimmed yet" (the safe direction, :10-19).
- On a failed batch: **stop**, keep what resolved, log — rate limiting is the
  expected failure (:70-75). Empty result means "not known yet", never an
  error (:30-33).
- `resolveGalleryTags` (:87-103): all galleries' ids in one pass so common
  tags resolve once for the page.
- Search-result tag resolution + dim matching is the only consumer pair
  (search-settings flow, 02-ipc-surface.md).

## 7. Testing — record/replay fixtures

- **Transport trait** (`http.rs`): `async fn send(RequestDef) -> ResponseDef`.
  Production impl wraps `reqwest`; test impl replays canned
  `tests/nhentai/fixtures/*.json` — one file per endpoint scenario, carrying
  status, headers (incl. `Retry-After`), and body, captured from the live API
  (anonymous tier) with a redaction pass for any key material.
- **Rate limiter:** unit tests with a fake clock — token refill arithmetic,
  FIFO fairness under N concurrent waiters, the single-drain burst property,
  sanitize fallbacks, `setRateLimit` mid-queue, anon↔auth tier swap, snapshot
  counts. Assert a scripted 25-call search never exceeds 10/min.
- **429 flows:** replay 429 with and without `Retry-After` through both retry
  models; assert the distinct timings and attempt accounting (client: one
  retry; sync: 429s don't consume attempts).
- **Query composition:** port `search-query.test.ts` (198 lines) case-for-case
  plus generated cases (fields typed with mixed case, quoted values with
  inner quotes stripped, dim/exclude mixes, duplicate negations).
- **Tags resolver:** replay batches — cold cache (capped at 3 batches),
  partial cache, mid-batch 429 (stop-and-keep semantics), id dedup.
- **Endpoint parity:** for each fixture, the Rust client's request (method,
  path, query, headers) is compared against what 1.x sends (captured once
  with a proxy); the response types must serde-parse every captured body
  without loss (round-trip JSON diff).
- **Pacing harness (integration):** run a 30-item sync against a local server
  that enforces the `gallery` anon limit; assert no 429 ever arrives and the
  observed interval matches `endpointLimitPerMinute`-derived pacing within
  jitter tolerance.

## 8. Exit criteria

1. All endpoints + URL builders request-identical to 1.x on the fixture set
   (method/path/query/headers, both UA strings).
2. Limiter property tests green (never exceeds the documented per-endpoint
   table, either tier); both retry models behaviour-identical on replayed 429s.
3. Query composition: full `search-query.test.ts` port green + fuzz corpus.
4. Tag resolver: cache-first, 100-id/3-batch caps, stop-on-failure semantics
   proven on replay fixtures.
5. Sync pacing derived from `endpointLimitPerMinute` (no hardcoded interval
   anywhere — grep-enforced).

## 9. Risks

| Risk | Mitigation |
|---|---|
| API drift vs the captured fixtures (nhentai is not ours) | fixtures re-recordable via a `KOPIBON_RECORD_DIR` harness mode; schema-level tests tolerate additive fields, pin known ones |
| Auth-tier behaviour untestable without a real key | tier swap is pure table logic (unit-tested); one optional live smoke test behind an env-var key, never in CI |
| serde silently defaulting fields the TS code reads as `undefined` | round-trip JSON diff against captured bodies (§7); explicit `#[serde(default)]` audit per type |
| Limiter clock skew between `std` and `tokio` time | single injected `Clock` abstraction shared with the tests |
| Two UAs / two retry models drift into one | §4.3 keeps separate modules; fixture asserts both UA strings |
