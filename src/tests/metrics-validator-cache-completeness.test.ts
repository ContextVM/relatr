import { describe, expect, test } from "bun:test";
import { MetricsValidator } from "@/validators/MetricsValidator";
import type { ProfileMetrics } from "@/types";

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

    expect(evaluateCalls).toBe(1);
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
});
