import { describe, expect, test } from "bun:test";
import { httpNip05Resolve } from "@/capabilities/http/httpNip05Resolve";
import { LruCache } from "@/utils/lru-cache";
import { Nip05FactRefreshStage } from "@/validation/Nip05FactRefreshStage";

describe("httpNip05Resolve persistent cache hooks", () => {
  test("returns persisted resolution before attempting live lookup", async () => {
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
        },
        nip05CacheStore: {
          getResolution: async (nip05: string) => {
            resolutionReads++;
            expect(nip05).toBe("alice@example.com");
            return { pubkey: "cached-pubkey" };
          },
          setResolution: async () => {
            throw new Error("setResolution should not be called on cache hit");
          },
        } as never,
      },
    );

    expect(result).toEqual({ pubkey: "cached-pubkey" });
    expect(resolutionReads).toBe(1);
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
    }) as unknown as typeof fetch;

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
          },
          nip05CacheStore: {
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error("setResolution should not be called on timeout");
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
    }) as unknown as typeof fetch;

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
          },
          validationRunContext: {
            nip05PreparedResults: preparedResults,
            nip05LiveFetchDisabled: true,
          },
          nip05CacheStore: {
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error(
                "setResolution should not be called for prepared facts",
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
    }) as unknown as typeof fetch;

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
          },
          validationRunContext: {
            nip05PreparedResults: new LruCache<{ pubkey: string | null }>(10),
            nip05LiveFetchDisabled: true,
          },
          nip05CacheStore: {
            getResolution: async () => null,
            setResolution: async () => {
              throw new Error(
                "setResolution should not be called when fallback is disabled",
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

  test("persists failed refresh outcomes so restarts do not immediately retry them", async () => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{
      nip05: string;
      pubkey: string | null;
      ttlSeconds: number;
    }> = [];

    globalThis.fetch = (async () => {
      throw new Error("Bad response: 404");
    }) as unknown as typeof fetch;

    try {
      const stage = new Nip05FactRefreshStage(
        {
          getBatch: async () =>
            new Map([["pk-target", { nip05: "Alice@Example.com" }]]),
        } as never,
        {
          getResolution: async () => null,
          setResolution: async (input: {
            nip05: string;
            pubkey: string | null;
            ttlSeconds: number;
          }) => {
            writes.push(input);
          },
        } as never,
        {
          capTimeoutMs: 1000,
          nip05ResolveTimeoutMs: 500,
          nip05CacheTtlSeconds: 3600,
          nip05DomainCooldownSeconds: 600,
        } as never,
        1,
      );

      await stage.refresh({
        pubkeys: ["pk-target"],
        validationRunContext: {},
      });

      expect(writes).toEqual([
        {
          nip05: "alice@example.com",
          pubkey: null,
          ttlSeconds: 3600,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("prepares run-scoped NIP-05 facts from persisted cache without live fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called on persisted cache hit");
    }) as unknown as typeof fetch;

    try {
      const validationRunContext: {
        nip05PreparedResults?: LruCache<{ pubkey: string | null }>;
        nip05LiveFetchDisabled?: boolean;
      } = {};

      const stage = new Nip05FactRefreshStage(
        {
          getBatch: async () =>
            new Map([
              ["pk-target", { nip05: "Alice@Example.com" }],
              ["pk-other", { nip05: "alice@example.com" }],
            ]),
        } as never,
        {
          getResolution: async (nip05: string) => {
            expect(nip05).toBe("alice@example.com");
            return { pubkey: "cached-pubkey" };
          },
          setResolution: async () => {
            throw new Error(
              "setResolution should not be called on persisted cache hit",
            );
          },
        } as never,
        {
          capTimeoutMs: 1000,
          nip05ResolveTimeoutMs: 500,
          nip05CacheTtlSeconds: 3600,
          nip05DomainCooldownSeconds: 600,
        } as never,
        1,
      );

      await stage.refresh({
        pubkeys: ["pk-target", "pk-other"],
        validationRunContext,
      });

      expect(validationRunContext.nip05LiveFetchDisabled).toBe(true);
      expect(
        validationRunContext.nip05PreparedResults?.get("alice@example.com"),
      ).toEqual({ pubkey: "cached-pubkey" });
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
