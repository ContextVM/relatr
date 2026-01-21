import { nowMs } from "@/utils/utils";

/**
 * Token bucket rate limiter for MCP server
 * Prevents relay connection instability under burst request loads
 */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private lastRefill: number;
  private readonly minRefillIntervalMs: number;

  /**
   * @param capacity - Maximum tokens (burst capacity)
   * @param refillRate - Tokens per second to refill
   * @param minRefillIntervalMs - Minimum interval between refills (precision protection)
   */
  constructor(
    capacity: number = 10,
    refillRate: number = 200,
    minRefillIntervalMs: number = 1,
  ) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = nowMs();
    this.minRefillIntervalMs = minRefillIntervalMs;
  }

  /**
   * Try to acquire a token for a request
   * @returns true if token acquired, false if rate limited
   */
  acquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Get remaining tokens (for monitoring)
   * Note: Does not trigger refill to avoid side effects from read operations.
   * Use acquire() if you need a token and want to trigger refill.
   */
  getRemainingTokens(): number {
    return this.tokens;
  }

  /**
   * Get current capacity (for monitoring)
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get refill rate (for monitoring)
   */
  getRefillRate(): number {
    return this.refillRate;
  }

  private refill(): void {
    const now = nowMs();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;

    // Only update if enough time has passed to generate meaningful tokens
    // This prevents precision drift from microsecond-level timing differences
    if (elapsed * 1000 > this.minRefillIntervalMs) {
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }
}
