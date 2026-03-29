import { describe, expect, test } from "bun:test";
import {
  buildPreparedValidationProfiles,
  buildValidationChunkContext,
  type ValidationChunkRuntime,
} from "@/validation/ValidationBatchExecution";

describe("ValidationBatchExecution", () => {
  test("buildPreparedValidationProfiles preserves pubkey order and reports missing coverage explicitly", () => {
    const prepared = buildPreparedValidationProfiles(
      ["pk-3", "pk-2", "pk-1"],
      new Map([
        ["pk-1", { pubkey: "pk-1", name: "one" }],
        ["pk-2", null],
        ["pk-3", { pubkey: "pk-3", name: "three" }],
      ]),
    );

    expect(Array.from(prepared.profilesByPubkey.keys())).toEqual([
      "pk-3",
      "pk-2",
      "pk-1",
    ]);
    expect(prepared.profilesByPubkey.get("pk-3")).toEqual({
      pubkey: "pk-3",
      name: "three",
    });
    expect(prepared.profilesByPubkey.get("pk-2")).toBeNull();
    expect(prepared.missingPubkeys).toEqual(["pk-2"]);
  });

  test("buildValidationChunkContext derives chunk profiles from the pubkey plan order", () => {
    const profileByPubkey = new Map([
      ["pk-1", { pubkey: "pk-1", name: "one" }],
      ["pk-2", null],
      ["pk-3", { pubkey: "pk-3", name: "three" }],
    ]);

    const runtime: ValidationChunkRuntime = {
      batchMetricResults: new Map(),
      evaluatePubkeyMetrics: async () => ({}),
      buildResult: ({ profile, computedMetrics }) => ({
        result: {
          pubkey: profile.pubkey,
          metrics: computedMetrics,
          computedAt: 1,
          expiresAt: 2,
        },
        computedMetrics,
        success: true,
      }),
    };

    const context = buildValidationChunkContext(
      {
        plan: {
          pubkeys: ["pk-3", "pk-2", "pk-1"],
          chunkNumber: 2,
          totalChunks: 4,
        },
        profileByPubkey,
        runtime,
      },
      {
        now: 100,
        cacheTtlSeconds: 50,
        expectedMetricKeys: new Set(["a"]),
        cachedMetrics: new Map(),
        metricsRepository: {
          upsertMetricSubsetBatch: async () => {},
        } as never,
        validationPubkeyConcurrency: 8,
        mapWithConcurrency: async (items, _limit, worker) => {
          return await Promise.all(items.map((item) => worker(item)));
        },
        getMissingExpectedMetricKeys: () => [],
      },
    );

    expect(context.pubkeys).toEqual(["pk-3", "pk-2", "pk-1"]);
    expect(context.chunkNumber).toBe(2);
    expect(context.totalChunks).toBe(4);
    expect(context.profiles.map((profile) => profile.pubkey)).toEqual([
      "pk-3",
      "pk-1",
    ]);
    expect(context.batchMetricResults).toBe(runtime.batchMetricResults);
    expect(context.evaluatePubkeyMetrics).toBe(runtime.evaluatePubkeyMetrics);
    expect(context.buildResult).toBe(runtime.buildResult);
  });
});
