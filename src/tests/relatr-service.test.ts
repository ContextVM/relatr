import { describe, expect, test } from "bun:test";
import { RelatrService } from "@/service/RelatrService";
import type { TrustScore } from "@/types";

describe("RelatrService", () => {
  test("filters disabled plugin validators from trust score output", () => {
    const service = new RelatrService({
      config: { defaultSourcePubkey: "source" },
      socialGraph: {},
      metricsValidator: {
        getResolvedWeights: () => ({ "pk:enabled-plugin": 0.7 }),
      },
      trustCalculator: {},
      searchService: {},
      schedulerService: undefined,
      dbManager: {},
      metadataRepository: {},
      taService: undefined,
      pluginManager: {},
    } as never);

    const trustScore: TrustScore = {
      sourcePubkey: "source",
      targetPubkey: "target",
      score: 0.5,
      computedAt: 1,
      components: {
        distanceWeight: 0.3,
        socialDistance: 1,
        normalizedDistance: 0.7,
        validators: {
          "pk:enabled-plugin": { score: 0.8 },
          "pk:disabled-plugin": { score: 0.2 },
        },
      },
    };

    const result = service["enrichTrustScoreWithDescriptions"](trustScore, {
      get: (name: string) => `${name} description`,
    } as never);

    expect(Object.keys(result.components.validators)).toEqual([
      "pk:enabled-plugin",
    ]);
    expect(result.components.validators["pk:enabled-plugin"]).toEqual({
      score: 0.8,
      description: "pk:enabled-plugin description",
    });
  });
});
