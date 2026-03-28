import { describe, expect, test } from "bun:test";
import type { ProfileMetrics } from "@/types";
import { CompositeFactRefreshStage } from "@/validation/FactRefreshStage";
import { ValidationPipeline } from "@/validation/ValidationPipeline";
import { buildMetricFactDependencyIndex } from "@/validation/fact-dependencies";

async function captureInfoLogs<T>(run: () => Promise<T>): Promise<string[]> {
  const originalLog = console.log;
  const messages: string[] = [];

  console.log = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
    return messages;
  } finally {
    console.log = originalLog;
  }
}

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
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await Promise.resolve();
  }
}

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

  test("owns fallback recovery when metrics validator batch execution throws", async () => {
    const validatedPubkeys: string[] = [];

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async () => {
          throw new Error("validator batch execution failed");
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

  test("fallback accounting records failed pubkeys through the shared batch result path", async () => {
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
        validateAll: async (pubkey: string) => {
          validatedPubkeys.push(pubkey);

          if (pubkey === "pk-b") {
            throw new Error("fallback failed");
          }

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

  test("threads validation run context from fact refresh into batch validation", async () => {
    let receivedPreparedProfiles:
      | Map<string, { pubkey: string } | null>
      | undefined;
    let receivedPreparedCoverage: Set<string> | undefined;

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (
          pubkeys: string[],
          _sourcePubkey?: string,
          _metricKeys?: string[],
          validationRunContext?: {
            preparedMetadataProfiles?: Map<string, { pubkey: string } | null>;
            metadataPreparedForPubkeys?: Set<string>;
          },
        ) => {
          receivedPreparedProfiles =
            validationRunContext?.preparedMetadataProfiles;
          receivedPreparedCoverage =
            validationRunContext?.metadataPreparedForPubkeys;
          return new Map(
            pubkeys.map((pubkey) => [pubkey, mkMetrics(pubkey, { metric: 1 })]),
          );
        },
      } as never,
      factRefreshStage: {
        refresh: async ({ pubkeys, validationRunContext }) => {
          validationRunContext!.preparedMetadataProfiles = new Map(
            pubkeys.map((pubkey) => [pubkey, { pubkey }]),
          );
          validationRunContext!.metadataPreparedForPubkeys = new Set(pubkeys);
        },
      },
    });

    await pipeline.runValidationSync(10);

    expect(receivedPreparedProfiles).toEqual(
      new Map([
        ["pk-a", { pubkey: "pk-a" }],
        ["pk-b", { pubkey: "pk-b" }],
      ]),
    );
    expect(receivedPreparedCoverage).toEqual(new Set(["pk-a", "pk-b"]));
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

  test("counts empty metric payloads as successful handled results", async () => {
    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) => {
          return new Map(
            pubkeys.map((pubkey) => [pubkey, mkMetrics(pubkey, {})]),
          );
        },
      } as never,
    });

    await expect(pipeline.runValidationSync(10)).resolves.toBeUndefined();
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

  test("graph-only metric warm-up skips unrelated NIP-05 refresh stage", async () => {
    const executionOrder: string[] = [];
    const graphOnlyPlugin = {
      pubkey: "pk-graph",
      manifest: { name: "reciprocity_mutual" },
      content:
        "plan mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey} in if mutual == true then 1.0 else 0.0",
    };

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
        eloEngine: {
          getRuntimeState: () => ({
            plugins: [graphOnlyPlugin],
            enabled: {},
            weightOverrides: {},
            resolvedWeights: {},
            metricFactDependencies: buildMetricFactDependencyIndex([
              graphOnlyPlugin,
            ]),
          }),
        },
      } as never,
      factRefreshStage: new CompositeFactRefreshStage([
        {
          label: "metadata refresh",
          factDomain: "metadata",
          refresh: async () => {
            executionOrder.push("metadata refresh");
          },
        },
        {
          label: "NIP-05 refresh",
          factDomain: "nip05",
          refresh: async () => {
            executionOrder.push("NIP-05 refresh");
          },
        },
      ]),
    });

    await pipeline.runValidationSync(10, undefined, [
      "pk-graph:reciprocity_mutual",
    ]);

    expect(executionOrder).toEqual([]);
  });

  test("scheduleValidationSync coalesces overlapping runs into a follow-up rerun", async () => {
    const firstRunGate = deferred<void>();
    const secondRunGate = deferred<void>();
    let runCount = 0;

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async () => {
          runCount++;

          if (runCount === 1) {
            await firstRunGate.promise;
          } else if (runCount === 2) {
            await secondRunGate.promise;
          }

          return new Map([["pk-a", mkMetrics("pk-a", { "pk:plugin_a": 1 })]]);
        },
      } as never,
    });

    pipeline.scheduleValidationSync();
    await waitFor(() => runCount === 1);

    expect(runCount).toBe(1);

    pipeline.scheduleValidationSync();
    pipeline.scheduleValidationSync();
    await Promise.resolve();

    expect(runCount).toBe(1);

    firstRunGate.resolve();
    await waitFor(() => runCount === 2);

    expect(runCount).toBe(2);

    secondRunGate.resolve();
    await Promise.resolve();
  });

  test("queued follow-up validation sync uses the latest narrowed metric scope", async () => {
    const firstRunGate = deferred<void>();
    const secondRunGate = deferred<void>();
    const seenMetricKeys: string[][] = [];
    let runCount = 0;

    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (
          _pubkeys: string[],
          _sourcePubkey?: string,
          metricKeys?: string[],
        ) => {
          runCount++;
          seenMetricKeys.push([...(metricKeys ?? [])]);

          if (runCount === 1) {
            await firstRunGate.promise;
          } else if (runCount === 2) {
            await secondRunGate.promise;
          }

          return new Map([["pk-a", mkMetrics("pk-a", { "pk:plugin_a": 1 })]]);
        },
      } as never,
    });

    pipeline.scheduleValidationSync(250, undefined, ["pk:first"]);
    await waitFor(() => runCount === 1);

    pipeline.scheduleValidationSync(250, undefined, ["pk:second"]);
    pipeline.scheduleValidationSync(250, undefined, ["pk:third"]);
    await Promise.resolve();

    firstRunGate.resolve();
    await waitFor(() => runCount === 2);

    expect(seenMetricKeys).toEqual([["pk:first"], ["pk:third"]]);

    secondRunGate.resolve();
    await Promise.resolve();
  });

  test("logs a cache-warm completion summary when no persistence or fallback is needed", async () => {
    const pipeline = new ValidationPipeline({
      config: { defaultSourcePubkey: "pk-source" } as never,
      socialGraph: {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      metricsValidator: {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_a": 1 }),
            ]),
          ),
      } as never,
    });

    const messages = await captureInfoLogs(async () => {
      await pipeline.runValidationSync(10, undefined, ["pk:plugin_a"]);
    });

    expect(
      messages.some((message) =>
        message.includes(
          "All 2/2 pubkeys were already ready for 1 requested metric; no metric persistence or fallback recovery was needed.",
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.includes(
          "Validation coverage progress: 2/2 checked, 2 ready, 0 failed",
        ),
      ),
    ).toBe(true);
  });
});
