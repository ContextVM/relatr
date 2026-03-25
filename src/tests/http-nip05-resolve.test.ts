import { describe, expect, test } from "bun:test";
import { httpNip05Resolve } from "@/capabilities/http/httpNip05Resolve";
import { LruCache } from "@/utils/lru-cache";

describe("httpNip05Resolve persistent cache hooks", () => {
  test("returns persisted resolution before attempting live lookup", async () => {
    let cooldownChecks = 0;
    let resolutionReads = 0;

    const result = await httpNip05Resolve(
      { nip05: "Alice@Example.com" },
      {
        targetPubkey: "pk-target",
        config: {
          capTimeoutMs: 1000,
          nip05ResolveTimeoutMs: 500,
          nip05CacheTtlSeconds: 3600,
          nip05DomainCooldownSeconds: 600,
        },
        capRunCache: {
          nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(10),
          nip05BadDomains: new LruCache<true>(10),
        },
        nip05CacheStore: {
          isDomainCoolingDown: async () => {
            cooldownChecks++;
            return false;
          },
          getResolution: async (nip05: string) => {
            resolutionReads++;
            expect(nip05).toBe("alice@example.com");
            return { pubkey: "cached-pubkey" };
          },
          setResolution: async () => {
            throw new Error("setResolution should not be called on cache hit");
          },
          markDomainCooldown: async () => {
            throw new Error(
              "markDomainCooldown should not be called on cache hit",
            );
          },
        } as never,
      },
    );

    expect(result).toEqual({ pubkey: "cached-pubkey" });
    expect(cooldownChecks).toBe(1);
    expect(resolutionReads).toBe(1);
  });

  test("returns null immediately when persistent domain cooldown is active", async () => {
    let resolutionReads = 0;

    const result = await httpNip05Resolve(
      { nip05: "_@example.com" },
      {
        targetPubkey: "pk-target",
        config: {
          capTimeoutMs: 1000,
          nip05ResolveTimeoutMs: 500,
          nip05CacheTtlSeconds: 3600,
          nip05DomainCooldownSeconds: 600,
        },
        capRunCache: {
          nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(10),
          nip05BadDomains: new LruCache<true>(10),
        },
        nip05CacheStore: {
          isDomainCoolingDown: async (domain: string) => {
            expect(domain).toBe("example.com");
            return true;
          },
          getResolution: async () => {
            resolutionReads++;
            return null;
          },
          setResolution: async () => {
            throw new Error(
              "setResolution should not be called during cooldown",
            );
          },
          markDomainCooldown: async () => {
            throw new Error(
              "markDomainCooldown should not be called when cooldown already exists",
            );
          },
        } as never,
      },
    );

    expect(result).toEqual({ pubkey: null });
    expect(resolutionReads).toBe(0);
  });

  test("aborts live lookup using the dedicated NIP-05 timeout", async () => {
    const originalFetch = globalThis.fetch;
    let aborted = false;

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const signal = init?.signal;

      await new Promise((resolve, reject) => {
        if (!signal) {
          reject(new Error("expected abort signal"));
          return;
        }

        const timeout = setTimeout(resolve, 200);
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timeout);
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          },
          { once: true },
        );
      });

      return new Response(JSON.stringify({ names: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await httpNip05Resolve(
        { nip05: "alice@example.com" },
        {
          targetPubkey: "pk-target",
          config: {
            capTimeoutMs: 1000,
            nip05ResolveTimeoutMs: 25,
            nip05CacheTtlSeconds: 3600,
            nip05DomainCooldownSeconds: 600,
          },
          capRunCache: {
            nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(10),
            nip05BadDomains: new LruCache<true>(10),
          },
          nip05CacheStore: {
            isDomainCoolingDown: async () => false,
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error("setResolution should not be called on timeout");
            },
            markDomainCooldown: async (domain: string) => {
              expect(domain).toBe("example.com");
            },
          } as never,
        },
      );

      expect(result).toEqual({ pubkey: null });
      expect(aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns prepared NIP-05 facts without performing a live fetch", async () => {
    let fetchCalled = false;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called when prepared facts exist");
    }) as typeof fetch;

    try {
      const preparedResults = new LruCache<{ pubkey: string | null }>(10);
      preparedResults.set("alice@example.com", { pubkey: "prepared-pubkey" });

      const result = await httpNip05Resolve(
        { nip05: "Alice@Example.com" },
        {
          targetPubkey: "pk-target",
          config: {
            capTimeoutMs: 1000,
            nip05ResolveTimeoutMs: 500,
            nip05CacheTtlSeconds: 3600,
            nip05DomainCooldownSeconds: 600,
          },
          capRunCache: {
            nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(10),
            nip05BadDomains: new LruCache<true>(10),
            nip05PreparedResults: preparedResults,
            nip05LiveFetchDisabled: true,
          },
          nip05CacheStore: {
            isDomainCoolingDown: async () => false,
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error(
                "setResolution should not be called for prepared facts",
              );
            },
            markDomainCooldown: async () => {
              throw new Error(
                "markDomainCooldown should not be called for prepared facts",
              );
            },
          } as never,
        },
      );

      expect(result).toEqual({ pubkey: "prepared-pubkey" });
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not perform a live fetch when the run disables NIP-05 fallback", async () => {
    let fetchCalled = false;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error(
        "fetch should not be called when live fallback is disabled",
      );
    }) as typeof fetch;

    try {
      const result = await httpNip05Resolve(
        { nip05: "alice@example.com" },
        {
          targetPubkey: "pk-target",
          config: {
            capTimeoutMs: 1000,
            nip05ResolveTimeoutMs: 500,
            nip05CacheTtlSeconds: 3600,
            nip05DomainCooldownSeconds: 600,
          },
          capRunCache: {
            nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(10),
            nip05BadDomains: new LruCache<true>(10),
            nip05PreparedResults: new LruCache<{ pubkey: string | null }>(10),
            nip05LiveFetchDisabled: true,
          },
          nip05CacheStore: {
            isDomainCoolingDown: async () => false,
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error(
                "setResolution should not be called when fallback is disabled",
              );
            },
            markDomainCooldown: async () => {
              throw new Error(
                "markDomainCooldown should not be called when fallback is disabled",
              );
            },
          } as never,
        },
      );

      expect(result).toEqual({ pubkey: null });
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
