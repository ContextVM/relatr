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
  test("syncValidations validates all graph pubkeys through MetricsValidator completeness logic", async () => {
    const allPubkeys = ["pk-a", "pk-b", "pk-c"];
    const seenBatches: string[][] = [];
    let coarseRepositoryCheckCalls = 0;

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
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await scheduler.syncValidations(2);

    expect(coarseRepositoryCheckCalls).toBe(0);
    expect(seenBatches).toEqual([["pk-a", "pk-b"], ["pk-c"]]);
  });

  test("syncValidations skips cleanly when the graph is empty", async () => {
    let validateAllBatchCalls = 0;

    const scheduler = new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
      } as never,
      {} as never,
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
      {} as never,
      {} as never,
      {} as never,
      {} as never,
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
      {} as never,
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
      {} as never,
      {} as never,
      {} as never,
      {} as never,
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
});
