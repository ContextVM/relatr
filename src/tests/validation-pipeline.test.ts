import { describe, expect, test } from "bun:test";
import type { ProfileMetrics } from "@/types";
import { CompositeFactRefreshStage } from "@/validation/FactRefreshStage";
import { ValidationPipeline } from "@/validation/ValidationPipeline";

function mkMetrics(
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

describe("ValidationPipeline", () => {
  test("runs batch validation across graph pubkeys", async () => {
    const allPubkeys = ["pk-a", "pk-b", "pk-c"];
    const seenBatches: string[][] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => allPubkeys,
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[], sourcePubkey?: string) => {
          seenBatches.push([...pubkeys]);
          expect(sourcePubkey).toBe("pk-source");
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_a": 1 }),
            ]),
          );
        },
      } as never,
    });

    await pipeline.runValidationSync(2);

    expect(seenBatches).toEqual([["pk-a", "pk-b"], ["pk-c"]]);
  });

  test("falls back to individual validation when batch validation fails", async () => {
    const validatedPubkeys: string[] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async () => {
          throw new Error("batch failed");
        },
        validateAll: async (pubkey: string, sourcePubkey?: string) => {
          expect(sourcePubkey).toBe("pk-source");
          validatedPubkeys.push(pubkey);
          return mkMetrics(pubkey, { "pk:plugin_a": 1 });
        },
      } as never,
    });

    await pipeline.runValidationSync(10);

    expect(validatedPubkeys).toEqual(["pk-a", "pk-b"]);
  });

  test("uses configured batch size to build batch plan before validation runs", async () => {
    const seenBatches: string[][] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => [
          "pk-a",
          "pk-b",
          "pk-c",
          "pk-d",
          "pk-e",
        ],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) => {
          seenBatches.push([...pubkeys]);
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_a": 1 }),
            ]),
          );
        },
      } as never,
    });

    await pipeline.runValidationSync(2);

    expect(seenBatches).toEqual([["pk-a", "pk-b"], ["pk-c", "pk-d"], ["pk-e"]]);
  });

  test("refreshes facts before validation batches run", async () => {
    const executionOrder: string[] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[], sourcePubkey?: string) => {
          executionOrder.push(`validate:${pubkeys.join(",")}:${sourcePubkey}`);
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_a": 1 }),
            ]),
          );
        },
      } as never,
      factRefreshStage: {
        refresh: async ({ pubkeys, sourcePubkey }) => {
          executionOrder.push(`refresh:${pubkeys.join(",")}:${sourcePubkey}`);
        },
      },
    });

    await pipeline.runValidationSync(10);

    expect(executionOrder).toEqual([
      "refresh:pk-a,pk-b:pk-source",
      "validate:pk-a,pk-b:pk-source",
    ]);
  });

  test("threads narrowed metric keys through batch validation", async () => {
    const seenMetricKeys: string[][] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (
          pubkeys: string[],
          sourcePubkey?: string,
          metricKeys?: string[],
        ) => {
          expect(sourcePubkey).toBe("pk-source");
          seenMetricKeys.push([...(metricKeys ?? [])]);
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_a": 1 }),
            ]),
          );
        },
      } as never,
    });

    await pipeline.runValidationSync(10, undefined, ["pk:plugin_a"]);

    expect(seenMetricKeys).toEqual([["pk:plugin_a"]]);
  });

  test("threads narrowed metric keys through fallback validation", async () => {
    const seenMetricKeys: string[][] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async () => {
          throw new Error("batch failed");
        },
        validateAll: async (
          pubkey: string,
          sourcePubkey?: string,
          metricKeys?: string[],
        ) => {
          expect(sourcePubkey).toBe("pk-source");
          seenMetricKeys.push([...(metricKeys ?? [])]);
          return mkMetrics(pubkey, { "pk:plugin_a": 1 });
        },
      } as never,
    });

    await pipeline.runValidationSync(10, undefined, ["pk:plugin_a"]);

    expect(seenMetricKeys).toEqual([["pk:plugin_a"], ["pk:plugin_a"]]);
  });

  test("times composite fact refresh stages individually", async () => {
    const executionOrder: string[] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [pubkey, mkMetrics(pubkey, { metric: 1 })]),
          ),
      } as never,
      factRefreshStage: new CompositeFactRefreshStage([
        {
          label: "metadata refresh",
          refresh: async () => {
            executionOrder.push("metadata refresh");
          },
        },
        {
          label: "NIP-05 refresh",
          refresh: async () => {
            executionOrder.push("NIP-05 refresh");
          },
        },
      ]),
    });

    await pipeline.runValidationSync(10);

    expect(executionOrder).toEqual(["metadata refresh", "NIP-05 refresh"]);
  });
});
