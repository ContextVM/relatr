import { describe, expect, test } from "bun:test";
import { SchedulerService } from "@/service/SchedulerService";
import type { ProfileMetrics } from "@/types";

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

describe("SchedulerService validation sync", () => {
  const mkSettingsRepository = () => ({
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  });

  const mkMetadataRepository = () => ({
    getBatch: async (pubkeys: string[]) =>
      new Map(pubkeys.map((pubkey) => [pubkey, { pubkey }])),
  });

  test("syncValidations validates all graph pubkeys through MetricsValidator completeness logic", async () => {
    const allPubkeys = ["pk-a", "pk-b", "pk-c"];
    const seenBatches: string[][] = [];
    let coarseRepositoryCheckCalls = 0;
    const refreshedPubkeys: string[][] = [];

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      {
        getPubkeysWithoutScores: async () => {
          coarseRepositoryCheckCalls++;
          return [];
        },
      } as never,
      {
        getAllUsersInGraph: async () => allPubkeys,
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[], sourcePubkey?: string) => {
          seenBatches.push([...pubkeys]);
          expect(sourcePubkey).toBe("pk-source");
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_b": 1 }),
            ]),
          );
        },
      } as never,
      {
        getBatch: async (pubkeys: string[]) =>
          new Map(pubkeys.map((pubkey) => [pubkey, null])),
      } as never,
      {
        fetchMetadata: async ({ pubkeys }: { pubkeys: string[] }) => {
          refreshedPubkeys.push([...pubkeys]);
          return {
            success: true,
            message: "ok",
            profilesFetched: pubkeys.length,
          };
        },
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    await scheduler.syncValidations(2);

    expect(coarseRepositoryCheckCalls).toBe(0);
    expect(refreshedPubkeys).toEqual([allPubkeys]);
    expect(seenBatches).toEqual([["pk-a", "pk-b"], ["pk-c"]]);
  });

  test("syncValidations skips metadata refresh when cached metadata is already fresh on restart", async () => {
    const refreshedPubkeys: string[][] = [];

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => ["pk-a", "pk-b"],
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_b": 1 }),
            ]),
          ),
      } as never,
      {
        getBatch: async (pubkeys: string[]) =>
          new Map(pubkeys.map((pubkey) => [pubkey, { pubkey }])),
      } as never,
      {
        fetchMetadata: async ({ pubkeys }: { pubkeys: string[] }) => {
          refreshedPubkeys.push([...pubkeys]);
          return {
            success: true,
            message: "ok",
            profilesFetched: pubkeys.length,
          };
        },
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    await scheduler.syncValidations(10);

    expect(refreshedPubkeys).toEqual([]);
  });

  test("syncValidations refreshes only missing metadata when restart cache coverage is partial", async () => {
    const refreshedPubkeys: string[][] = [];

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => ["pk-a", "pk-b", "pk-c"],
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_b": 1 }),
            ]),
          ),
      } as never,
      {
        getBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              pubkey === "pk-b" ? null : { pubkey },
            ]),
          ),
      } as never,
      {
        fetchMetadata: async ({ pubkeys }: { pubkeys: string[] }) => {
          refreshedPubkeys.push([...pubkeys]);
          return {
            success: true,
            message: "ok",
            profilesFetched: pubkeys.length,
          };
        },
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    await scheduler.syncValidations(10);

    expect(refreshedPubkeys).toEqual([["pk-b"]]);
  });

  test("bootstrap metadata coverage suppresses the immediate validation refresh once even when pubkey order changes and cached metadata prevents a second refresh", async () => {
    const refreshedPubkeys: string[][] = [];
    let metadataBatchReads = 0;

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => ["pk-b", "pk-a"],
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) =>
          new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              mkMetrics(pubkey, { "pk:plugin_b": 1 }),
            ]),
          ),
      } as never,
      {
        getBatch: async (pubkeys: string[]) => {
          metadataBatchReads++;
          return new Map(
            pubkeys.map((pubkey) => [
              pubkey,
              metadataBatchReads === 1 ? null : { pubkey },
            ]),
          );
        },
      } as never,
      {
        fetchMetadata: async ({ pubkeys }: { pubkeys: string[] }) => {
          refreshedPubkeys.push([...pubkeys]);
          return {
            success: true,
            message: "ok",
            profilesFetched: pubkeys.length,
          };
        },
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    scheduler.markBootstrapMetadataFresh(["pk-a", "pk-b"], "pk-source");

    await scheduler.syncValidations(10);
    await scheduler.syncValidations(10);

    expect(refreshedPubkeys).toEqual([]);
  });

  test("syncValidations skips cleanly when the graph is empty", async () => {
    let validateAllBatchCalls = 0;

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => [],
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async () => {
          validateAllBatchCalls++;
          return new Map();
        },
      } as never,
      mkMetadataRepository() as never,
      {
        fetchMetadata: async () => ({
          success: true,
          message: "ok",
          profilesFetched: 0,
        }),
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    await scheduler.syncValidations(10);

    expect(validateAllBatchCalls).toBe(0);
  });

  test("scheduleValidationWarmup coalesces overlapping requests into a follow-up rerun", async () => {
    const firstRunGate = deferred<void>();
    const secondRunGate = deferred<void>();
    let runCount = 0;

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => ["pk-a"],
      } as never,
      {
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
      mkMetadataRepository() as never,
      {
        fetchMetadata: async () => ({
          success: true,
          message: "ok",
          profilesFetched: 1,
        }),
      } as never,
      mkSettingsRepository() as never,
      mkMetadataRepository() as never,
      mkMetadataRepository() as never,
    );

    scheduler.scheduleValidationWarmup();
    await waitFor(() => runCount === 1);

    expect(runCount).toBe(1);

    scheduler.scheduleValidationWarmup();
    scheduler.scheduleValidationWarmup();
    await Promise.resolve();

    expect(runCount).toBe(1);

    firstRunGate.resolve();
    await waitFor(() => runCount === 2);

    expect(runCount).toBe(2);

    secondRunGate.resolve();
    await Promise.resolve();
  });

  test("scheduleValidationWarmup forwards narrowed metric keys into validation sync", async () => {
    const seenMetricKeys: string[][] = [];

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      mkMetadataRepository() as never,
      {
        getAllUsersInGraph: async () => ["pk-a"],
      } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (
          _pubkeys: string[],
          _sourcePubkey?: string,
          metricKeys?: string[],
        ) => {
          seenMetricKeys.push([...(metricKeys ?? [])]);
          return new Map([["pk-a", mkMetrics("pk-a", { "pk:plugin_a": 1 })]]);
        },
      } as never,
      mkMetadataRepository() as never,
      {
        fetchMetadata: async () => ({
          success: true,
          message: "ok",
          profilesFetched: 1,
        }),
      } as never,
      mkSettingsRepository() as never,
      {} as never,
      {} as never,
    );

    scheduler.scheduleValidationWarmup(undefined, ["pk:plugin_a"]);
    await waitFor(() => seenMetricKeys.length === 1);

    expect(seenMetricKeys).toEqual([["pk:plugin_a"]]);
  });
});
