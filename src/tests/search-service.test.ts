import { describe, expect, test } from "bun:test";
import { SearchService } from "@/service/SearchService";
import type {
  NostrProfile,
  ProfileMetrics,
  RelatrConfig,
  TrustScore,
} from "@/types";

function createTrustScore(targetPubkey: string, score: number): TrustScore {
  return {
    sourcePubkey: "source",
    targetPubkey,
    score,
    computedAt: 1,
    components: {
      distanceWeight: 0.5,
      socialDistance: 1,
      normalizedDistance: 1,
      validators: {},
    },
  };
}

function createService(overrides?: {
  socialGraph?: Partial<ConstructorParameters<typeof SearchService>[2]>;
  metricsValidator?: Partial<ConstructorParameters<typeof SearchService>[3]>;
  trustCalculator?: Partial<ConstructorParameters<typeof SearchService>[4]>;
}) {
  const config: RelatrConfig = {
    defaultSourcePubkey: "source",
    databasePath: "test.db",
    nostrRelays: [],
    serverSecretKey: "a".repeat(64),
    serverRelays: [],
    taExtraRelays: [],
    decayFactor: 0.5,
    cacheTtlHours: 24,
    numberOfHops: 2,
    syncIntervalHours: 1,
    cleanupIntervalHours: 1,
    validationSyncIntervalHours: 1,
    taEnabled: false,
    eloPluginsDir: "./plugins",
    eloPluginTimeoutMs: 1000,
    capTimeoutMs: 1000,
    nip05ResolveTimeoutMs: 1000,
    nip05CacheTtlSeconds: 60,
    nip05DomainCooldownSeconds: 60,
    eloBatchPubkeyConcurrency: 1,
    eloPluginConcurrency: 1,
    validationFallbackConcurrency: 1,
    eloMaxRoundsPerPlugin: 1,
    eloMaxRequestsPerRound: 1,
    eloMaxTotalRequestsPerPlugin: 1,
    eloPluginWeights: {},
    adminPubkeys: [],
    isPublicServer: false,
  };

  return new SearchService(
    config,
    {
      search: async () => [],
      save: async () => undefined,
    } as never,
    {
      getCurrentRoot: () => "source",
      getDistancesBatch: async (pubkeys: string[]) =>
        new Map(pubkeys.map((pubkey) => [pubkey, 2])),
      ...overrides?.socialGraph,
    } as never,
    {
      getStoredMetrics: async (pubkeys: string[]) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              metrics: {},
              computedAt: 1,
              expiresAt: 2,
            } satisfies ProfileMetrics,
          ]),
        ),
      ...overrides?.metricsValidator,
    } as never,
    {
      calculate: (_source: string, target: string) =>
        createTrustScore(target, 0.5),
      ...overrides?.trustCalculator,
    } as never,
    null as never,
  );
}

describe("SearchService relevance scoring", () => {
  test("treats nip05 and lud16 exact matches as exact matches for relay candidates", () => {
    const service = createService();

    const nip05Profile: NostrProfile = {
      pubkey: "pk1",
      nip05: "alice@example.com",
    };
    const lud16Profile: NostrProfile = {
      pubkey: "pk2",
      lud16: "alice@wallet.example",
    };

    expect(
      service.calculateRelevanceMultiplier(nip05Profile, "alice@example.com"),
    ).toEqual({ multiplier: 1.04, isExactMatch: true });
    expect(
      service.calculateRelevanceMultiplier(
        lud16Profile,
        "alice@wallet.example",
      ),
    ).toEqual({ multiplier: 1.028, isExactMatch: true });
  });

  test("includes about text as a low-weight relevance signal", () => {
    const service = createService();

    const profile: NostrProfile = {
      pubkey: "pk-about",
      about: "building sovereign nostr tools for the open web",
    };

    expect(service.calculateRelevanceMultiplier(profile, "nostr")).toEqual({
      multiplier: 1.007,
      isExactMatch: false,
    });
  });
});

describe("SearchService final score calculation", () => {
  test("keeps absolute combined scores instead of renormalizing the candidate batch", async () => {
    const service = createService({
      socialGraph: {
        getDistancesBatch: async () =>
          new Map([
            ["pk-a", 1],
            ["pk-b", 1],
          ]),
      },
      metricsValidator: {
        getStoredMetrics: async () =>
          new Map([
            [
              "pk-a",
              {
                pubkey: "pk-a",
                metrics: {},
                computedAt: 1,
                expiresAt: 2,
              } satisfies ProfileMetrics,
            ],
            [
              "pk-b",
              {
                pubkey: "pk-b",
                metrics: {},
                computedAt: 1,
                expiresAt: 2,
              } satisfies ProfileMetrics,
            ],
          ]),
      },
      trustCalculator: {
        calculate: (_source: string, target: string) =>
          createTrustScore(target, target === "pk-a" ? 0.8 : 0.6),
      },
    });

    const results = await service.calculateProfileScores(
      [
        {
          pubkey: "pk-a",
          relevanceMultiplier: 1.1,
          isExactMatch: false,
        },
        {
          pubkey: "pk-b",
          relevanceMultiplier: 1.1,
          isExactMatch: false,
        },
      ],
      "source",
    );

    expect(results).toEqual([
      { pubkey: "pk-a", trustScore: 0.88, exactMatch: false },
      { pubkey: "pk-b", trustScore: 0.66, exactMatch: false },
    ]);
  });

  test("applies the reduced exact-match boost", async () => {
    const service = createService({
      trustCalculator: {
        calculate: (_source: string, target: string) =>
          createTrustScore(target, 0.5),
      },
    });

    const [result] = await service.calculateProfileScores(
      [
        {
          pubkey: "pk-exact",
          relevanceMultiplier: 1.2,
          isExactMatch: true,
        },
      ],
      "source",
    );

    expect(result).toEqual({
      pubkey: "pk-exact",
      trustScore: 0.63,
      exactMatch: true,
    });
  });
});
