/**
 * Rate limiting for nhentai API calls.
 *
 * The v2 API enforces limits *per endpoint*, not globally, and most limits
 * differ between anonymous and authenticated callers. A single global bucket
 * either throttles far too aggressively (popular is only 8/min) or not nearly
 * enough (search is only 10/min anonymous), so we keep one token bucket per
 * endpoint group and resize them when auth state changes.
 *
 * Limits below are taken from openapi_documentation.json.
 */

export class RateLimiter {
  private tokens: number
  private maxTokens: number
  private refillRate: number // tokens per millisecond
  private lastRefill: number
  private waiters: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false

  /**
   * @param maxRequestsPerMinute - Maximum requests allowed per minute
   */
  constructor(maxRequestsPerMinute = 30) {
    this.maxTokens = RateLimiter.sanitize(maxRequestsPerMinute, 30)
    this.tokens = this.maxTokens
    this.refillRate = this.maxTokens / 60_000
    this.lastRefill = Date.now()
  }

  /**
   * Reject NaN / Infinity / <= 0. Passing a bad value used to poison the
   * bucket so thoroughly that rate limiting silently stopped working
   * entirely, so all entry points funnel through here.
   */
  private static sanitize(value: unknown, fallback: number): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return n
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }

  /**
   * Acquire a token. Resolves immediately if one is available, otherwise
   * queues FIFO until enough tokens have refilled.
   *
   * Waiters are served from a single drain loop so that N concurrent callers
   * can't each independently decide "one token will be free in X ms" and then
   * all fire at once (which drove the bucket negative and produced bursts
   * well over the limit).
   */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.drain()
    })
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    this.pump()
  }

  private pump(): void {
    this.timer = null
    this.refill()

    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      const resolve = this.waiters.shift()!
      resolve()
    }

    if (this.waiters.length > 0) {
      const deficit = 1 - this.tokens
      const waitMs = Math.max(10, Math.ceil(deficit / this.refillRate))
      this.timer = setTimeout(() => this.pump(), waitMs)
    } else {
      this.draining = false
    }
  }

  /**
   * Try to acquire a token without waiting.
   * Returns true if acquired, false if not available.
   */
  tryAcquire(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /**
   * Set a new rate limit. Invalid values are ignored rather than applied.
   */
  setRateLimit(maxRequestsPerMinute: number): void {
    const next = RateLimiter.sanitize(maxRequestsPerMinute, this.maxTokens)
    this.refill()
    this.maxTokens = next
    this.refillRate = next / 60_000
    this.tokens = Math.min(this.tokens, next)
    // Re-evaluate any queued waiters against the new rate
    if (this.waiters.length > 0) {
      if (this.timer) clearTimeout(this.timer)
      this.draining = false
      this.drain()
    }
  }

  /**
   * Get the current number of available tokens.
   */
  getAvailableTokens(): number {
    this.refill()
    return this.tokens
  }

  getLimit(): number {
    return this.maxTokens
  }
}

// ─── Per-endpoint limits ─────────────────────────────────────────────────────

/**
 * Endpoint groups the app actually calls. Values are requests/minute as
 * documented in the OpenAPI spec.
 */
export type EndpointKey =
  | 'search'
  | 'galleries'
  | 'gallery'
  | 'popular'
  | 'related'
  | 'favorite'
  | 'favorites'
  | 'user'
  | 'meta'
  | 'tagsIds'
  | 'tagsSearch'

const ENDPOINT_LIMITS: Record<EndpointKey, { anon: number; auth: number }> = {
  search: { anon: 10, auth: 20 }, // GET /search
  galleries: { anon: 15, auth: 30 }, // GET /galleries
  gallery: { anon: 20, auth: 45 }, // GET /galleries/{id}
  popular: { anon: 8, auth: 8 }, // GET /galleries/popular — flat 8/min
  related: { anon: 12, auth: 30 }, // GET /galleries/{id}/related
  favorite: { anon: 15, auth: 15 }, // GET|POST|DELETE /galleries/{id}/favorite
  favorites: { anon: 15, auth: 15 }, // GET /favorites
  user: { anon: 45, auth: 45 }, // GET /user
  meta: { anon: 30, auth: 30 }, // GET /cdn, GET /config — no documented limit
  // Both are public endpoints with a flat documented limit, so anon and auth
  // match. tagsIds is the tighter of the two and is the one dim mode leans on,
  // which is why resolution is batched 100 ids at a time and cached.
  tagsIds: { anon: 15, auth: 15 }, // GET /tags/ids
  tagsSearch: { anon: 30, auth: 30 } // POST /tags/search
}

/**
 * Holds one bucket per endpoint group and swaps between the anonymous and
 * authenticated limit sets.
 */
export class ApiRateLimiter {
  private buckets = new Map<EndpointKey, RateLimiter>()
  private authenticated = false

  constructor(authenticated = false) {
    this.authenticated = authenticated
    for (const key of Object.keys(ENDPOINT_LIMITS) as EndpointKey[]) {
      this.buckets.set(key, new RateLimiter(this.limitFor(key)))
    }
  }

  private limitFor(key: EndpointKey): number {
    const limits = ENDPOINT_LIMITS[key]
    return this.authenticated ? limits.auth : limits.anon
  }

  /**
   * Switch every bucket between the anon and auth limit sets. Called when a
   * key is validated, restored, or cleared.
   */
  setAuthenticated(authenticated: boolean): void {
    if (this.authenticated === authenticated) return
    this.authenticated = authenticated
    for (const [key, bucket] of this.buckets) {
      bucket.setRateLimit(this.limitFor(key))
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated
  }

  acquire(key: EndpointKey): Promise<void> {
    const bucket = this.buckets.get(key)
    if (!bucket) return Promise.resolve()
    return bucket.acquire()
  }

  /** Diagnostics: current token count per endpoint group. */
  snapshot(): Record<string, { available: number; limit: number }> {
    const out: Record<string, { available: number; limit: number }> = {}
    for (const [key, bucket] of this.buckets) {
      out[key] = {
        available: Math.floor(bucket.getAvailableTokens()),
        limit: bucket.getLimit()
      }
    }
    return out
  }
}
