import { describe, expect, test } from "bun:test";
import { MetricsValidator } from "@/validators/MetricsValidator";
import type { ProfileMetrics } from "@/types";
import type { ProfileFetcher } from "@/graph/RelayProfileFetcher";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 100,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mkCached(
  pubkey: string,
  metrics: Record<string, number>,
): ProfileMetrics {
  return {
    pubkey,
    metrics,
    computedAt: 1700000000,
    expiresAt: 1700003600,
  };
}

describe("MetricsValidator cache completeness", () => {
  test("validateAll recomputes when cached metrics miss an enabled plugin key", async () => {
    const target = "pk-target";
    const expectedKeys = ["pk:plugin_a", "pk:plugin_b"];

    let upsertSubsetCalls = 0;
    let upsertedSubset: Record<string, number> | null = null;
    const repo = {
      get: async (_pubkey: string) =>
        mkCached(target, {
          [expectedKeys[0]!]: 0.7,
        }),
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async (
        _pubkey: string,
        metrics: Record<string, number>,
      ) => {
        upsertSubsetCalls++;
        upsertedSubset = { ...metrics };
      },
      upsertMetricSubsetBatch: async () => {},
    };

    let evaluateCalls = 0;
    let receivedMetricKeys: string[] | undefined;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [
          { pubkey: "pk", manifest: { name: "plugin_a" } },
          { pubkey: "pk", manifest: { name: "plugin_b" } },
        ],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async (input: { metricKeys?: string[] }) => {
        evaluateCalls++;
        receivedMetricKeys = input.metricKeys;
        return {
          [expectedKeys[1]!]: 0.2,
        };
      },
      getMetricDescriptions: () => ({
        get: () => undefined,
      }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      {} as never,
      eloEngine as never,
    );

    const result = await validator.validateAll(target, "pk-source");

    expect(evaluateCalls).toBe(1);
    expect(receivedMetricKeys).toEqual([expectedKeys[1]!]);
    expect(upsertSubsetCalls).toBe(1);
    if (!upsertedSubset) {
      throw new Error("Expected upsertedSubset to be populated");
    }
    const missingKey = expectedKeys[1]!;
    if (upsertedSubset[missingKey] === undefined) {
      throw new Error(`Expected upsertedSubset to contain ${missingKey}`);
    }
    expect(upsertedSubset[missingKey] as number).toBe(0.2);
    expect(result.metrics[expectedKeys[0]!]).toBe(0.7);
    expect(result.metrics[expectedKeys[1]!]).toBe(0.2);
  });

  test("validateAll returns cached metrics immediately when the expected keyset is complete", async () => {
    const target = "pk-target";
    const cached = mkCached(target, {
      "pk:plugin_a": 0.7,
      "pk:plugin_b": 0.2,
    });

    let evaluateCalls = 0;
    const repo = {
      get: async () => cached,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {
        throw new Error("upsertMetricSubset should not be called");
      },
      upsertMetricSubsetBatch: async () => {},
    };

    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [
          { pubkey: "pk", manifest: { name: "plugin_a" } },
          { pubkey: "pk", manifest: { name: "plugin_b" } },
        ],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async () => {
        evaluateCalls++;
        return {};
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      {} as never,
      eloEngine as never,
    );

    const result = await validator.validateAll(target);

    expect(evaluateCalls).toBe(0);
    expect(result).toBe(cached);
  });

  test("validateAll returns default metrics when evaluation throws", async () => {
    const target = "pk-target";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async () => {
        throw new Error("boom");
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      {} as never,
      eloEngine as never,
    );

    const result = await validator.validateAll(target);

    expect(result.pubkey).toBe(target);
    expect(result.metrics).toEqual({});
  });

  test("validateAllBatch uses cache only when expected plugin keyset is complete", async () => {
    const completePubkey = "pk-complete";
    const incompletePubkey = "pk-incomplete";
    const expectedKeys = ["pk:plugin_a", "pk:plugin_b"];

    let upsertBatchCalls = 0;
    let upsertBatchEntries: Array<{
      pubkey: string;
      metrics: Record<string, number>;
    }> = [];
    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async (pubkeys: string[]) => {
        const map = new Map<string, ProfileMetrics | null>();
        for (const pubkey of pubkeys) {
          if (pubkey === completePubkey) {
            map.set(
              pubkey,
              mkCached(pubkey, {
                [expectedKeys[0]!]: 0.6,
                [expectedKeys[1]!]: 0.4,
              }),
            );
          } else if (pubkey === incompletePubkey) {
            map.set(
              pubkey,
              mkCached(pubkey, {
                [expectedKeys[0]!]: 0.9,
              }),
            );
          }
        }
        return map;
      },
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async (
        entries: Array<{ pubkey: string; metrics: Record<string, number> }>,
      ) => {
        upsertBatchCalls++;
        upsertBatchEntries = entries.map((entry) => ({
          pubkey: entry.pubkey,
          metrics: { ...entry.metrics },
        }));
      },
    };

    const metadataRepository = {
      getBatch: async (pubkeys: string[]) => {
        return new Map(pubkeys.map((pubkey) => [pubkey, { pubkey }]));
      },
    };

    let evaluateCalls = 0;
    let evaluateBatchCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [
          { pubkey: "pk", manifest: { name: "plugin_a" } },
          { pubkey: "pk", manifest: { name: "plugin_b" } },
        ],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async (input: {
        targetPubkey: string;
        metricKeys?: string[];
      }) => {
        evaluateCalls++;
        expect(input.metricKeys).toEqual([expectedKeys[1]!]);
        return {
          [expectedKeys[1]!]:
            input.targetPubkey === incompletePubkey ? 0.3 : 0.4,
        };
      },
      evaluateBatchForPubkeys: async (input: {
        targetPubkeys: string[];
        metricKeys?: string[];
      }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual([incompletePubkey]);
        expect(input.metricKeys).toEqual([expectedKeys[1]!]);
        return new Map([[incompletePubkey, { [expectedKeys[1]!]: 0.3 }]]);
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    const results = await validator.validateAllBatch([
      completePubkey,
      incompletePubkey,
    ]);

    expect(evaluateCalls).toBe(0);
    expect(evaluateBatchCalls).toBe(1);
    expect(upsertBatchCalls).toBe(1);
    expect(upsertBatchEntries).toEqual([
      {
        pubkey: incompletePubkey,
        metrics: { [expectedKeys[1]!]: 0.3 },
      },
    ]);
    expect(results.get(completePubkey)?.metrics[expectedKeys[1]!]).toBe(0.4);
    expect(results.get(incompletePubkey)?.metrics[expectedKeys[1]!]).toBe(0.3);
  });

  test("validateAllBatch prefers metadata prepared in the validation run context", async () => {
    const targetPubkey = "pk-target";
    const metricKey = "pk:plugin_a";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    let metadataRepositoryReads = 0;
    const metadataRepository = {
      getBatch: async () => {
        metadataRepositoryReads++;
        return new Map([[targetPubkey, { pubkey: targetPubkey }]]);
      },
    };

    let evaluateBatchCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateBatchForPubkeys: async (input: { targetPubkeys: string[] }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual([targetPubkey]);
        return new Map([[targetPubkey, { [metricKey]: 1 }]]);
      },
      evaluateForPubkey: async () => {
        throw new Error("evaluateForPubkey should not be called");
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    const results = await validator.validateAllBatch(
      [targetPubkey],
      undefined,
      undefined,
      {
        preparedMetadataProfiles: new Map([
          [targetPubkey, { pubkey: targetPubkey }],
        ]),
        metadataPreparedForPubkeys: new Set([targetPubkey]),
      },
    );

    expect(metadataRepositoryReads).toBe(0);
    expect(evaluateBatchCalls).toBe(1);
    expect(results.get(targetPubkey)?.metrics[metricKey]).toBe(1);
  });

  test("validateAllBatch falls back to repository metadata reads when validation run coverage is incomplete", async () => {
    const targetPubkey = "pk-target";
    const metricKey = "pk:plugin_a";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    let metadataRepositoryReads = 0;
    const metadataRepository = {
      getBatch: async (pubkeys: string[]) => {
        metadataRepositoryReads++;
        expect(pubkeys).toEqual([targetPubkey]);
        return new Map([[targetPubkey, { pubkey: targetPubkey }]]);
      },
    };

    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateBatchForPubkeys: async () =>
        new Map([[targetPubkey, { [metricKey]: 1 }]]),
      evaluateForPubkey: async () => {
        throw new Error("evaluateForPubkey should not be called");
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    await validator.validateAllBatch([targetPubkey], undefined, undefined, {
      preparedMetadataProfiles: new Map(),
      metadataPreparedForPubkeys: new Set(),
    });

    expect(metadataRepositoryReads).toBe(1);
  });

  test("validateAllBatch falls back to relay profile fetching when prepared metadata coverage contains null profiles", async () => {
    const targetPubkey = "pk-target";
    const metricKey = "pk:plugin_a";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    let metadataRepositoryReads = 0;
    const metadataRepository = {
      getBatch: async () => {
        metadataRepositoryReads++;
        return new Map([[targetPubkey, { pubkey: targetPubkey }]]);
      },
    };

    let fetchedPubkeys: string[] = [];
    const profileFetcher: ProfileFetcher = {
      fetchProfiles: async (pubkeys: string[]) => {
        fetchedPubkeys = [...pubkeys];
        return new Map([[targetPubkey, { pubkey: targetPubkey }]]);
      },
    };

    let evaluateBatchCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateBatchForPubkeys: async (input: { targetPubkeys: string[] }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual([targetPubkey]);
        return new Map([[targetPubkey, { [metricKey]: 1 }]]);
      },
      evaluateForPubkey: async () => {
        throw new Error("evaluateForPubkey should not be called");
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
      undefined,
      profileFetcher,
    );

    const results = await validator.validateAllBatch(
      [targetPubkey],
      undefined,
      undefined,
      {
        preparedMetadataProfiles: new Map([[targetPubkey, null]]),
        metadataPreparedForPubkeys: new Set([targetPubkey]),
      },
    );

    expect(metadataRepositoryReads).toBe(0);
    expect(fetchedPubkeys).toEqual([targetPubkey]);
    expect(evaluateBatchCalls).toBe(1);
    expect(results.get(targetPubkey)?.metrics[metricKey]).toBe(1);
  });

  test("validateAllBatch delegates missing relay profile fallback to the injected profile fetcher", async () => {
    const targetPubkey = "pk-target";
    const metricKey = "pk:plugin_a";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    const metadataRepository = {
      getBatch: async (pubkeys: string[]) => {
        expect(pubkeys).toEqual([targetPubkey]);
        return new Map([[targetPubkey, null]]);
      },
    };

    let fetchedPubkeys: string[] = [];
    const profileFetcher: ProfileFetcher = {
      fetchProfiles: async (pubkeys: string[]) => {
        fetchedPubkeys = [...pubkeys];
        return new Map([[targetPubkey, { pubkey: targetPubkey }]]);
      },
    };

    let evaluateBatchCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateBatchForPubkeys: async (input: { targetPubkeys: string[] }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual([targetPubkey]);
        return new Map([[targetPubkey, { [metricKey]: 1 }]]);
      },
      evaluateForPubkey: async () => {
        throw new Error("evaluateForPubkey should not be called");
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
      undefined,
      profileFetcher,
    );

    const results = await validator.validateAllBatch([targetPubkey]);

    expect(fetchedPubkeys).toEqual([targetPubkey]);
    expect(evaluateBatchCalls).toBe(1);
    expect(results.get(targetPubkey)?.metrics[metricKey]).toBe(1);
  });

  test("validateAllBatch narrows recomputation to the requested metric scope", async () => {
    const targetPubkey = "pk-target";
    const cachedMetricKey = "pk:plugin_a";
    const scopedMetricKey = "pk:plugin_b";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async (pubkeys: string[]) => {
        return new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            mkCached(pubkey, {
              [cachedMetricKey]: 0.6,
            }),
          ]),
        );
      },
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async (
        entries: Array<{ pubkey: string; metrics: Record<string, number> }>,
      ) => {
        expect(entries).toEqual([
          {
            pubkey: targetPubkey,
            metrics: { [scopedMetricKey]: 0.4 },
          },
        ]);
      },
    };

    const metadataRepository = {
      getBatch: async (pubkeys: string[]) => {
        return new Map(pubkeys.map((pubkey) => [pubkey, { pubkey }]));
      },
    };

    let evaluateCalls = 0;
    let evaluateBatchCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [
          { pubkey: "pk", manifest: { name: "plugin_a" } },
          { pubkey: "pk", manifest: { name: "plugin_b" } },
        ],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async (input: {
        targetPubkey: string;
        metricKeys?: string[];
      }) => {
        evaluateCalls++;
        expect(input.targetPubkey).toBe(targetPubkey);
        expect(input.metricKeys).toEqual([scopedMetricKey]);
        return {
          [scopedMetricKey]: 0.4,
        };
      },
      evaluateBatchForPubkeys: async (input: {
        targetPubkeys: string[];
        metricKeys?: string[];
      }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual([targetPubkey]);
        expect(input.metricKeys).toEqual([scopedMetricKey]);
        return new Map([[targetPubkey, { [scopedMetricKey]: 0.4 }]]);
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    const results = await validator.validateAllBatch(
      [targetPubkey],
      undefined,
      [scopedMetricKey],
    );

    expect(evaluateCalls).toBe(0);
    expect(evaluateBatchCalls).toBe(1);
    expect(results.get(targetPubkey)?.metrics[cachedMetricKey]).toBe(0.6);
    expect(results.get(targetPubkey)?.metrics[scopedMetricKey]).toBe(0.4);
  });

  test("validateAllBatch batches missing metric evaluation across incomplete pubkeys", async () => {
    const pubkeys = ["pk-a", "pk-b"];
    const metricKey = "pk:plugin_b";

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async (inputPubkeys: string[]) => {
        return new Map(
          inputPubkeys.map((pubkey) => [
            pubkey,
            mkCached(pubkey, { "pk:plugin_a": 0.5 }),
          ]),
        );
      },
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async (
        entries: Array<{ pubkey: string; metrics: Record<string, number> }>,
      ) => {
        expect(entries).toEqual([
          { pubkey: "pk-a", metrics: { [metricKey]: 0.2 } },
          { pubkey: "pk-b", metrics: { [metricKey]: 0.8 } },
        ]);
      },
    };

    const metadataRepository = {
      getBatch: async (inputPubkeys: string[]) => {
        return new Map(inputPubkeys.map((pubkey) => [pubkey, { pubkey }]));
      },
    };

    let evaluateBatchCalls = 0;
    let evaluateCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [
          { pubkey: "pk", manifest: { name: "plugin_a" } },
          { pubkey: "pk", manifest: { name: "plugin_b" } },
        ],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async () => {
        evaluateCalls++;
        return {};
      },
      evaluateBatchForPubkeys: async (input: {
        targetPubkeys: string[];
        metricKeys?: string[];
      }) => {
        evaluateBatchCalls++;
        expect(input.targetPubkeys).toEqual(pubkeys);
        expect(input.metricKeys).toEqual([metricKey]);
        return new Map([
          ["pk-a", { [metricKey]: 0.2 }],
          ["pk-b", { [metricKey]: 0.8 }],
        ]);
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    const results = await validator.validateAllBatch(pubkeys);

    expect(evaluateCalls).toBe(0);
    expect(evaluateBatchCalls).toBe(1);
    expect(results.get("pk-a")?.metrics[metricKey]).toBe(0.2);
    expect(results.get("pk-b")?.metrics[metricKey]).toBe(0.8);
  });

  test("validateAll returns empty metrics without evaluating when no validators are configured", async () => {
    const target = "pk-target";

    let repoGetCalls = 0;
    const repo = {
      get: async () => {
        repoGetCalls++;
        return null;
      },
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {
        throw new Error("upsertMetricSubset should not be called");
      },
      upsertMetricSubsetBatch: async () => {},
    };

    let evaluateCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async () => {
        evaluateCalls++;
        return {};
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      {} as never,
      eloEngine as never,
    );

    const result = await validator.validateAll(target, "pk-source");

    expect(validator.hasConfiguredValidators()).toBe(false);
    expect(repoGetCalls).toBe(0);
    expect(evaluateCalls).toBe(0);
    expect(result.pubkey).toBe(target);
    expect(result.metrics).toEqual({});
  });

  test("validateAllBatch returns empty metrics for all pubkeys when no validators are configured", async () => {
    const pubkeys = ["pk-a", "pk-b"];

    let repoGetBatchCalls = 0;
    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => {
        repoGetBatchCalls++;
        return new Map<string, ProfileMetrics | null>();
      },
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {
        throw new Error("upsertMetricSubsetBatch should not be called");
      },
    };

    let evaluateCalls = 0;
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async () => {
        evaluateCalls++;
        return {};
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      {} as never,
      eloEngine as never,
    );

    const results = await validator.validateAllBatch(pubkeys, "pk-source");

    expect(repoGetBatchCalls).toBe(0);
    expect(evaluateCalls).toBe(0);
    expect(Array.from(results.keys())).toEqual(pubkeys);
    for (const pubkey of pubkeys) {
      expect(results.get(pubkey)).toEqual(
        expect.objectContaining({
          pubkey,
          metrics: {},
        }),
      );
    }
  });

  test("validateAllBatch bounds pubkey validation concurrency within a chunk", async () => {
    const pubkeys = Array.from({ length: 12 }, (_, index) => `pk-${index}`);
    const gates = new Map(
      pubkeys.map((pubkey) => [pubkey, deferred<Record<string, number>>()]),
    );

    const repo = {
      get: async () => null,
      save: async () => {},
      getBatch: async () => new Map<string, ProfileMetrics | null>(),
      saveBatch: async () => {},
      upsertMetricSubset: async () => {},
      upsertMetricSubsetBatch: async () => {},
    };

    const metadataRepository = {
      getBatch: async (requestedPubkeys: string[]) => {
        return new Map(requestedPubkeys.map((pubkey) => [pubkey, { pubkey }]));
      },
    };

    let activeValidations = 0;
    let maxConcurrentValidations = 0;
    const startedPubkeys: string[] = [];
    const eloEngine = {
      getRuntimeState: () => ({
        plugins: [{ pubkey: "pk", manifest: { name: "plugin_a" } }],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      evaluateForPubkey: async (input: { targetPubkey: string }) => {
        activeValidations++;
        maxConcurrentValidations = Math.max(
          maxConcurrentValidations,
          activeValidations,
        );
        startedPubkeys.push(input.targetPubkey);
        try {
          return await gates.get(input.targetPubkey)!.promise;
        } finally {
          activeValidations--;
        }
      },
      getMetricDescriptions: () => ({ get: () => undefined }),
      getResolvedWeights: () => ({}),
    };

    const validator = new MetricsValidator(
      {} as never,
      ["wss://relay.example"],
      {} as never,
      repo as never,
      metadataRepository as never,
      eloEngine as never,
    );

    const validationPromise = validator.validateAllBatch(pubkeys);
    await waitFor(() => startedPubkeys.length === 8);

    expect(maxConcurrentValidations).toBeLessThanOrEqual(8);
    expect(startedPubkeys.length).toBe(8);

    for (const pubkey of pubkeys) {
      gates.get(pubkey)!.resolve({ "pk:plugin_a": 1 });
    }

    const results = await validationPromise;
    expect(results.size).toBe(pubkeys.length);
    expect(maxConcurrentValidations).toBeLessThanOrEqual(8);
  });
});
