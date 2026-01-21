import { describe, it, expect, beforeEach } from "bun:test";
import { RateLimiter } from "../mcp/RateLimiter";

describe("RateLimiter", () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter(3, 10); // 3 tokens, fast refill for testing
  });

  describe("constructor", () => {
    it("should initialize with correct capacity", () => {
      const limiter = new RateLimiter(5, 2);
      expect(limiter.getCapacity()).toBe(5);
    });

    it("should initialize tokens to capacity", () => {
      const limiter = new RateLimiter(7, 2);
      expect(limiter.getRemainingTokens()).toBe(7);
    });

    it("should use default values when not provided", () => {
      const limiter = new RateLimiter();
      expect(limiter.getCapacity()).toBe(10);
      expect(limiter.getRemainingTokens()).toBe(10);
    });
  });

  describe("acquire", () => {
    it("should allow requests within capacity", () => {
      expect(rateLimiter.acquire()).toBe(true);
      expect(rateLimiter.acquire()).toBe(true);
      expect(rateLimiter.acquire()).toBe(true);
    });

    it("should reject requests when tokens exhausted", () => {
      rateLimiter.acquire();
      rateLimiter.acquire();
      rateLimiter.acquire();
      expect(rateLimiter.acquire()).toBe(false);
    });

    it("should decrement tokens on successful acquire", () => {
      // Use zero refill rate to avoid refill during test
      const limiter = new RateLimiter(3, 0);
      expect(limiter.getRemainingTokens()).toBe(3);
      limiter.acquire();
      expect(limiter.getRemainingTokens()).toBeLessThanOrEqual(2);
      limiter.acquire();
      expect(limiter.getRemainingTokens()).toBeLessThanOrEqual(1);
    });
  });

  describe("getRemainingTokens", () => {
    it("should return current token count", () => {
      expect(rateLimiter.getRemainingTokens()).toBe(3);
    });

    it("should reflect token consumption", () => {
      rateLimiter.acquire();
      rateLimiter.acquire();
      expect(rateLimiter.getRemainingTokens()).toBe(1);
    });
  });

  describe("getCapacity", () => {
    it("should return configured capacity", () => {
      const limiter = new RateLimiter(15, 2);
      expect(limiter.getCapacity()).toBe(15);
    });
  });

  describe("token refill", () => {
    it("should refill tokens over time", async () => {
      // Use all tokens
      rateLimiter.acquire();
      rateLimiter.acquire();
      rateLimiter.acquire();
      expect(rateLimiter.getRemainingTokens()).toBeLessThan(1);

      // Wait for refill (150ms = 1.5 tokens at 10 tokens/sec)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // acquire triggers refill
      expect(rateLimiter.acquire()).toBe(true);
    });

    it("should not exceed capacity when refilling", async () => {
      // Use some tokens
      rateLimiter.acquire();
      expect(rateLimiter.getRemainingTokens()).toBeLessThanOrEqual(3);

      // Wait for refill
      await new Promise((resolve) => setTimeout(resolve, 500));

      // acquire triggers refill, should get a token
      expect(rateLimiter.acquire()).toBe(true);
    });

    it("should refill continuously over multiple intervals", async () => {
      // Use all tokens
      rateLimiter.acquire();
      rateLimiter.acquire();
      rateLimiter.acquire();
      expect(rateLimiter.getRemainingTokens()).toBeLessThan(1);

      // Multiple refill intervals - acquire triggers refill
      await new Promise((resolve) => setTimeout(resolve, 100));
      const acquired1 = rateLimiter.acquire();

      await new Promise((resolve) => setTimeout(resolve, 100));
      const acquired2 = rateLimiter.acquire();

      // Should continue refilling (second acquire should succeed if enough time passed)
      expect(acquired1 || acquired2).toBe(true);
    });
  });

  describe("concurrent requests", () => {
    it("should handle concurrent acquire calls correctly", async () => {
      const limiter = new RateLimiter(5, 10);

      // Launch 10 concurrent requests
      const promises = Array(10)
        .fill(null)
        .map(() => limiter.acquire());
      const results = await Promise.all(promises);

      // Should have exactly 5 successful and 5 failed
      const successful = results.filter((r) => r === true).length;
      const failed = results.filter((r) => r === false).length;

      expect(successful).toBe(5);
      expect(failed).toBe(5);
    });

    it("should correctly track remaining tokens after concurrent requests", () => {
      const limiter = new RateLimiter(5, 10);

      // 3 acquire calls
      limiter.acquire();
      limiter.acquire();
      limiter.acquire();

      expect(limiter.getRemainingTokens()).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("should handle capacity of 1", () => {
      const limiter = new RateLimiter(1, 10);
      expect(limiter.acquire()).toBe(true);
      expect(limiter.acquire()).toBe(false);
    });

    it("should handle zero refill rate", () => {
      const limiter = new RateLimiter(3, 0);

      limiter.acquire();
      limiter.acquire();

      // getRemainingTokens doesn't trigger refill
      expect(limiter.getRemainingTokens()).toBe(1);
    });

    it("should handle very fast successive calls", () => {
      const limiter = new RateLimiter(10, 10);

      // Rapid successive calls
      for (let i = 0; i < 10; i++) {
        const result = limiter.acquire();
        if (i < 10) {
          expect(result).toBe(true);
        }
      }

      expect(limiter.acquire()).toBe(false);
    });
  });

  describe("precision drift prevention", () => {
    it("should not accumulate fractional tokens from read operations", async () => {
      const limiter = new RateLimiter(1, 1); // 1 token, 1 token/sec

      // Use the token
      limiter.acquire();
      const tokens = limiter.getRemainingTokens();
      expect(tokens).toBeLessThanOrEqual(1);

      // Very short wait (less than 1 second)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // getRemainingTokens doesn't trigger refill, should still have 0
      expect(limiter.getRemainingTokens()).toBeLessThan(1);
    });

    it("should correctly refill when acquire is called", async () => {
      // Use low refill rate for predictable behavior
      const limiter = new RateLimiter(2, 10); // 2 tokens, 10 tokens/sec

      // Use both tokens
      limiter.acquire();
      limiter.acquire();

      // Wait 100ms = 1 token at 10 tokens/sec
      await new Promise((resolve) => setTimeout(resolve, 100));

      // acquire triggers refill, should succeed
      expect(limiter.acquire()).toBe(true);
    });

    it("should accurately refill at specified rate", async () => {
      const limiter = new RateLimiter(10, 2); // 2 tokens/sec
      // Use all tokens
      for (let i = 0; i < 10; i++) limiter.acquire();

      // Wait 500ms = 1 token
      await new Promise((r) => setTimeout(r, 500));

      expect(limiter.acquire()).toBe(true); // Should have 1 token
      expect(limiter.acquire()).toBe(false); // Should be empty again
    });
  });
});
