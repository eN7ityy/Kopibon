/**
 * Token bucket rate limiter for nhentai API calls.
 *
 * Default: 30 requests/minute (anonymous), configurable via API key.
 * Uses a simple token bucket algorithm with refill.
 */

export class RateLimiter {
  private tokens: number
  private maxTokens: number
  private refillRate: number // tokens per millisecond
  private lastRefill: number

  /**
   * @param maxRequestsPerMinute - Maximum requests allowed per minute
   */
  constructor(maxRequestsPerMinute = 30) {
    this.maxTokens = maxRequestsPerMinute
    this.tokens = maxRequestsPerMinute
    this.refillRate = maxRequestsPerMinute / 60_000 // per ms
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const newTokens = elapsed * this.refillRate
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens)
    this.lastRefill = now
  }

  /**
   * Acquire a token. Resolves immediately if available, otherwise
   * waits until a token becomes available.
   */
  async acquire(): Promise<void> {
    this.refill()

    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }

    // Calculate wait time until next token
    const waitTime = Math.ceil((1 - this.tokens) / this.refillRate)

    return new Promise((resolve) => {
      setTimeout(() => {
        this.tokens -= 1
        this.lastRefill = Date.now()
        resolve()
      }, waitTime)
    })
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
   * Set a new rate limit (e.g., from API config response).
   */
  setRateLimit(maxRequestsPerMinute: number): void {
    this.maxTokens = maxRequestsPerMinute
    this.refillRate = maxRequestsPerMinute / 60_000
    this.tokens = Math.min(this.tokens, maxRequestsPerMinute)
  }

  /**
   * Get the current number of available tokens.
   */
  getAvailableTokens(): number {
    this.refill()
    return this.tokens
  }
}
