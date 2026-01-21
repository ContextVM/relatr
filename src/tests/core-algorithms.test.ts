import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { TrustCalculator } from "../trust/TrustCalculator";
import { SocialGraph } from "../graph/SocialGraph";
import type { RelatrConfig, ProfileMetrics } from "../types";
import { DatabaseManager } from "../database/DatabaseManager";
import { normalizeDistance, nowSeconds } from "@/utils/utils";
import { DEFAULT_METRIC_WEIGHTS } from "../config";

/**
 * Tests for TrustCalculator and SocialGraph core algorithms
 */

// Test configuration
const testConfig: RelatrConfig = {
  defaultSourcePubkey:
    "0000000000000000000000000000000000000000000000000000000000000001",
  databasePath: ":memory:",
  nostrRelays: ["wss://relay.example.com"],
  serverSecretKey: "test_server_secret_key",
  serverRelays: ["wss://relay.example.com"],
  decayFactor: 0.5,
  cacheTtlHours: 1,
  numberOfHops: 1,
  syncIntervalHours: 1,
  cleanupIntervalHours: 1,
  validationSyncIntervalHours: 1,
  taEnabled: false,
  isPublicServer: false,
  taExtraRelays: [],
};

/**
 * Test weights - match canonical defaults used by TrustCalculator.
 * Keep this in sync by importing the single source of truth.
 */
const testWeights = DEFAULT_METRIC_WEIGHTS;

// Test data
const testMetrics: ProfileMetrics = {
  pubkey: "0000000000000000000000000000000000000000000000000000000000000002",
  metrics: {
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 1.0,
    reciprocity: 0.8,
    isRootNip05: 0.5,
  },
  computedAt: nowSeconds(),
  expiresAt: nowSeconds() + 1000,
};

// Shared instances
let calculator: TrustCalculator;
let socialGraph: SocialGraph;

beforeAll(async () => {
  calculator = new TrustCalculator(testConfig);

  // Initialize DuckDB connection and social graph once for all tests
  const dbManager = DatabaseManager.getInstance(":memory:");
  await dbManager.initialize();
  const duckDb = dbManager.getWriteConnection();

  socialGraph = new SocialGraph(duckDb);
  await socialGraph.initialize(
    "0000000000000000000000000000000000000000000000000000000000000000",
  );
});

afterAll(() => {
  // Cleanup
  socialGraph?.cleanup();
});

describe("TrustCalculator - Distance Normalization", () => {
  test("should normalize distance = 0 to 1.0", () => {
    expect(normalizeDistance(0)).toBe(1.0);
  });

  test("should apply exponential decay formula correctly", () => {
    const distance = 2;
    const expected = Math.exp(-testConfig.decayFactor * distance);
    expect(normalizeDistance(distance)).toBeCloseTo(expected, 6);
  });

  test("should return 0.0 for distance = 1000", () => {
    expect(normalizeDistance(1000)).toBe(0.0);
  });

  test("should clamp values to [0,1] range", () => {
    for (let distance = 0; distance <= 10; distance++) {
      const normalized = normalizeDistance(distance);
      expect(normalized).toBeGreaterThanOrEqual(0.0);
      expect(normalized).toBeLessThanOrEqual(1.0);
    }
  });

  test("should throw error for invalid distances", () => {
    expect(() => normalizeDistance(-1)).toThrow();
    expect(() => normalizeDistance(NaN)).toThrow();
    expect(() => normalizeDistance(Infinity)).toThrow();
  });
});

describe("TrustCalculator - Score Calculation", () => {
  test("should compute correct weighted score", () => {
    const sourcePubkey =
      "0000000000000000000000000000000000000000000000000000000000000003";
    const targetPubkey =
      "0000000000000000000000000000000000000000000000000000000000000004";
    const distance = 2;

    const result = calculator.calculate(
      sourcePubkey,
      targetPubkey,
      testMetrics,
      distance,
    );

    // Verify formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
    // Compute expectation the same way as production: apply weights to all present metrics
    const normalizedDistance = Math.exp(-testConfig.decayFactor * distance);
    const weights = testWeights;

    const validatorWeights = weights.validators as Record<string, number>;

    let weightedSum = weights.distanceWeight * normalizedDistance;
    for (const [metricName, metricValue] of Object.entries(
      testMetrics.metrics,
    )) {
      const w = validatorWeights[metricName];
      if (w !== undefined) {
        weightedSum += w * (metricValue ?? 0);
      }
    }

    const totalWeight =
      weights.distanceWeight +
      Object.values(weights.validators).reduce(
        (sum, weight) => sum + weight,
        0,
      );

    const expectedScore = weightedSum / totalWeight;

    // Score is rounded to 2 decimal places, so we use precision of 2
    expect(result.score).toBeCloseTo(expectedScore, 2);
  });

  test("should include all components in result", () => {
    const result = calculator.calculate(
      "0000000000000000000000000000000000000000000000000000000000000005",
      "0000000000000000000000000000000000000000000000000000000000000006",
      testMetrics,
      1,
    );

    expect(result).toHaveProperty("sourcePubkey");
    expect(result).toHaveProperty("targetPubkey");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("computedAt");

    // Verify components structure
    expect(result.components).toHaveProperty("distanceWeight");
    expect(result.components).toHaveProperty("validators");
    expect(result.components.validators).toHaveProperty("nip05Valid");
    expect(result.components.validators).toHaveProperty("lightningAddress");
    expect(result.components.validators).toHaveProperty("eventKind10002");
    expect(result.components.validators).toHaveProperty("reciprocity");
    expect(result.components).toHaveProperty("socialDistance");
    expect(result.components).toHaveProperty("normalizedDistance");
  });

  test("should validate input parameters", () => {
    expect(() =>
      calculator.calculate(
        "",
        "0000000000000000000000000000000000000000000000000000000000000007",
        testMetrics,
        1,
      ),
    ).toThrow();
    expect(() =>
      calculator.calculate(
        "0000000000000000000000000000000000000000000000000000000000000008",
        "",
        testMetrics,
        1,
      ),
    ).toThrow();
    expect(() =>
      calculator.calculate(
        "0000000000000000000000000000000000000000000000000000000000000009",
        "000000000000000000000000000000000000000000000000000000000000000a",
        /* eslint-disable @typescript-eslint/no-explicit-any */
        null as any,
        1,
      ),
    ).toThrow();
    expect(() =>
      calculator.calculate(
        "000000000000000000000000000000000000000000000000000000000000000b",
        "000000000000000000000000000000000000000000000000000000000000000c",
        testMetrics,
        -1,
      ),
    ).toThrow();
  });

  test("should handle edge case with zero metrics", () => {
    const zeroMetrics: ProfileMetrics = {
      pubkey:
        "000000000000000000000000000000000000000000000000000000000000000d",
      metrics: {
        nip05Valid: 0,
        lightningAddress: 0,
        eventKind10002: 0,
        reciprocity: 0,
        isRootNip05: 0,
      },
      computedAt: nowSeconds(),
      expiresAt: nowSeconds() + 1000,
    };

    const sourcePubkey =
      "000000000000000000000000000000000000000000000000000000000000000e";
    const targetPubkey =
      "000000000000000000000000000000000000000000000000000000000000000f";

    // With distance 1000, normalized distance is 0, so all weighted components are 0
    const result = calculator.calculate(
      sourcePubkey,
      targetPubkey,
      zeroMetrics,
      1000,
    );
    expect(result.score).toBe(0);
  });
});

describe("TrustCalculator - Score Rounding", () => {
  test("should round score to 2 decimal places", () => {
    const result = calculator.calculate(
      "0000000000000000000000000000000000000000000000000000000000000012",
      "0000000000000000000000000000000000000000000000000000000000000013",
      testMetrics,
      1,
    );

    // Check that score has at most 2 decimal places
    const scoreStr = result.score.toString();
    const decimalPart = scoreStr.split(".")[1] || "";
    expect(decimalPart.length).toBeLessThanOrEqual(2);
  });

  test("should round component values to 2 decimal places", () => {
    const result = calculator.calculate(
      "0000000000000000000000000000000000000000000000000000000000000014",
      "0000000000000000000000000000000000000000000000000000000000000015",
      testMetrics,
      2,
    );

    // Check all component values
    const checkDecimalPlaces = (value: number) => {
      const valueStr = value.toString();
      const decimalPart = valueStr.split(".")[1] || "";
      expect(decimalPart.length).toBeLessThanOrEqual(2);
    };

    checkDecimalPlaces(result.components.distanceWeight);
    checkDecimalPlaces(result.components.validators.nip05Valid || 0);
    checkDecimalPlaces(result.components.validators.lightningAddress || 0);
    checkDecimalPlaces(result.components.validators.eventKind10002 || 0);
    checkDecimalPlaces(result.components.validators.reciprocity || 0);
    checkDecimalPlaces(result.components.socialDistance);
    checkDecimalPlaces(result.components.normalizedDistance);
  });

  test("should maintain score accuracy after rounding", () => {
    // Use a distance that creates a long decimal
    const distance = 3.7;
    const result = calculator.calculate(
      "0000000000000000000000000000000000000000000000000000000000000016",
      "0000000000000000000000000000000000000000000000000000000000000017",
      testMetrics,
      distance,
    );

    // Score should be between 0 and 1
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);

    // Rounding should not create values outside valid range
    expect(result.components.normalizedDistance).toBeGreaterThanOrEqual(0);
    expect(result.components.normalizedDistance).toBeLessThanOrEqual(1);
  });
});

describe("SocialGraph - Basic Operations", () => {
  test("should create instance and initialize correctly", () => {
    expect(socialGraph).toBeDefined();
    expect(socialGraph.isInitialized()).toBe(true);
    expect(socialGraph.getCurrentRoot()).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("should throw error when created with invalid connection", () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */

    expect(() => new SocialGraph(null as any)).toThrow();
  });

  test("should get distance between pubkeys", async () => {
    const distance = await socialGraph.getDistance(
      "0000000000000000000000000000000000000000000000000000000000000018",
    );
    expect(typeof distance).toBe("number");
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThanOrEqual(1000);
  });

  test("should check follow relationships", async () => {
    const follows = await socialGraph.doesFollow(
      "0000000000000000000000000000000000000000000000000000000000000019",
      "000000000000000000000000000000000000000000000000000000000000001a",
    );
    expect(typeof follows).toBe("boolean");
  });

  test("should get graph statistics", async () => {
    const stats = await socialGraph.getStats();
    expect(stats).toHaveProperty("users");
    expect(stats).toHaveProperty("follows");
    expect(stats).toHaveProperty("sizeByDistance");
    expect(stats.users).toBeGreaterThanOrEqual(0);
    expect(stats.follows).toBeGreaterThanOrEqual(0);
  });

  test("should switch root pubkey", async () => {
    const newRoot =
      "000000000000000000000000000000000000000000000000000000000000001b";
    await socialGraph.switchRoot(newRoot);
    expect(socialGraph.getCurrentRoot()).toBe(newRoot);

    // Switch back for other tests
    await socialGraph.switchRoot(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("should validate parameters", () => {
    expect(() => socialGraph.getDistance("")).toThrow();
    expect(() =>
      socialGraph.doesFollow(
        "",
        "000000000000000000000000000000000000000000000000000000000000001c",
      ),
    ).toThrow();
    expect(() =>
      socialGraph.doesFollow(
        "000000000000000000000000000000000000000000000000000000000000001d",
        "",
      ),
    ).toThrow();
  });

  test("should throw errors when not initialized", async () => {
    const dbManager = DatabaseManager.getInstance(":memory:test");
    await dbManager.initialize();
    const duckDb = dbManager.getWriteConnection();
    const uninitializedGraph = new SocialGraph(duckDb);

    expect(() => uninitializedGraph.getCurrentRoot()).toThrow();
    expect(() =>
      uninitializedGraph.getDistance(
        "000000000000000000000000000000000000000000000000000000000000001e",
      ),
    ).toThrow();
    expect(() =>
      uninitializedGraph.doesFollow(
        "000000000000000000000000000000000000000000000000000000000000001f",
        "0000000000000000000000000000000000000000000000000000000000000020",
      ),
    ).toThrow();
  });
});

describe("Integration - TrustCalculator + SocialGraph", () => {
  test("should calculate trust score using actual social graph distance", async () => {
    const targetPubkey =
      "0000000000000000000000000000000000000000000000000000000000000021";
    const distance = await socialGraph.getDistance(targetPubkey);

    const score = calculator.calculate(
      "0000000000000000000000000000000000000000000000000000000000000000",
      targetPubkey,
      testMetrics,
      distance,
    );

    expect(score).toHaveProperty("score");
    expect(score.components.socialDistance).toBe(distance);
    expect(score.components.normalizedDistance).toBeGreaterThanOrEqual(0);
    expect(score.components.normalizedDistance).toBeLessThanOrEqual(1);
  });
});
