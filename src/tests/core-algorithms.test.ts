import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { TrustCalculator } from "../trust/TrustCalculator";
import { SocialGraph } from "../graph/SocialGraph";
import { SimpleCache } from "../database/cache";
import type { RelatrConfig, TrustScore, ProfileMetrics } from "../types";

/**
 * Phase 2 Component Tests
 * Tests for TrustCalculator and SocialGraph core algorithms
 */

// Test configuration
const testConfig: RelatrConfig = {
  defaultSourcePubkey: "test_source_pubkey",
  graphBinaryPath: "./data/socialGraph.bin",
  databasePath: ":memory:",
  nostrRelays: ["wss://relay.example.com"],
  decayFactor: 0.5,
  cacheTtlSeconds: 3600,
  weights: {
    distanceWeight: 0.4,
    nip05Valid: 0.2,
    lightningAddress: 0.15,
    eventKind10002: 0.15,
    reciprocity: 0.1,
  },
};

// Test data
const testMetrics: ProfileMetrics = {
  pubkey: "test_target_pubkey",
  nip05Valid: 1.0,
  lightningAddress: 1.0,
  eventKind10002: 1.0,
  reciprocity: 0.8,
  computedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

// Shared instances
let db: Database;
let calculator: TrustCalculator;
let socialGraph: SocialGraph;

beforeAll(async () => {
  // Initialize database
  db = new Database(":memory:");
  calculator = new TrustCalculator(testConfig);

  // Initialize social graph once for all tests
  socialGraph = new SocialGraph("./data/socialGraph.bin");
  await socialGraph.initialize("test_root_pubkey");
});

afterAll(() => {
  // Cleanup
  socialGraph?.cleanup();
  db.close();
});

describe("TrustCalculator - Distance Normalization", () => {
  test("should normalize distance = 0 to 1.0", () => {
    expect(calculator.normalizeDistance(0)).toBe(1.0);
  });

  test("should apply exponential decay formula correctly", () => {
    const distance = 2;
    const expected = Math.exp(-testConfig.decayFactor * distance);
    expect(calculator.normalizeDistance(distance)).toBeCloseTo(expected, 6);
  });

  test("should return 0.0 for distance = 1000", () => {
    expect(calculator.normalizeDistance(1000)).toBe(0.0);
  });

  test("should handle different decay factors", () => {
    const config1 = { ...testConfig, decayFactor: 0.3 };
    const calc1 = new TrustCalculator(config1);

    const config2 = { ...testConfig, decayFactor: 0.7 };
    const calc2 = new TrustCalculator(config2);

    const normalized1 = calc1.normalizeDistance(1);
    const normalized2 = calc2.normalizeDistance(1);

    expect(normalized2).toBeLessThan(normalized1);
  });

  test("should clamp values to [0,1] range", () => {
    for (let distance = 0; distance <= 10; distance++) {
      const normalized = calculator.normalizeDistance(distance);
      expect(normalized).toBeGreaterThanOrEqual(0.0);
      expect(normalized).toBeLessThanOrEqual(1.0);
    }
  });

  test("should throw error for invalid distances", () => {
    expect(() => calculator.normalizeDistance(-1)).toThrow();
    expect(() => calculator.normalizeDistance(NaN)).toThrow();
    expect(() => calculator.normalizeDistance(Infinity)).toThrow();
  });
});

describe("TrustCalculator - Score Calculation", () => {
  test("should compute correct weighted score", () => {
    const sourcePubkey = "source_test_123";
    const targetPubkey = "target_test_456";
    const distance = 2;

    const result = calculator.calculate(
      sourcePubkey,
      targetPubkey,
      testMetrics,
      distance,
    );

    // Verify formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
    const normalizedDistance = Math.exp(-testConfig.decayFactor * distance);
    const weights = testConfig.weights;

    const weightedSum =
      weights.distanceWeight * normalizedDistance +
      weights.nip05Valid * testMetrics.nip05Valid +
      weights.lightningAddress * testMetrics.lightningAddress +
      weights.eventKind10002 * testMetrics.eventKind10002 +
      weights.reciprocity * testMetrics.reciprocity;

    const totalWeight = Object.values(weights).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    const expectedScore = weightedSum / totalWeight;

    // Score is now rounded to 3 decimal places, so we use precision of 2
    expect(result.score).toBeCloseTo(expectedScore, 2);
  });

  test("should include all components in result", () => {
    const result = calculator.calculate("source", "target", testMetrics, 1);

    expect(result).toHaveProperty("sourcePubkey");
    expect(result).toHaveProperty("targetPubkey");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("computedAt");

    // Verify components structure
    expect(result.components).toHaveProperty("distanceWeight");
    expect(result.components).toHaveProperty("nip05Valid");
    expect(result.components).toHaveProperty("lightningAddress");
    expect(result.components).toHaveProperty("eventKind10002");
    expect(result.components).toHaveProperty("reciprocity");
    expect(result.components).toHaveProperty("socialDistance");
    expect(result.components).toHaveProperty("normalizedDistance");
  });

  test("should handle custom weights override", () => {
    // Create custom weights that will sum to 1.0 when merged
    // testConfig has: distance=0.4, nip05=0.2, lightning=0.15, event=0.15, reciprocity=0.1
    // We override distance and nip05, keep the rest
    const customWeights = {
      distanceWeight: 0.5,
      nip05Valid: 0.25,
      lightningAddress: 0.1,
      eventKind10002: 0.1,
      reciprocity: 0.05
    }; // Sum = 1.0
    const sourcePubkey = "custom_weights_source";
    const targetPubkey = "custom_weights_target";

    const result = calculator.calculate(
      sourcePubkey,
      targetPubkey,
      testMetrics,
      1,
      customWeights,
    );

    // The components should show the final weights used in calculation (rounded)
    expect(result.components.distanceWeight).toBe(0.5);
    expect(result.components.nip05Valid).toBe(0.25);
    expect(result.components.lightningAddress).toBe(0.1);
    expect(result.components.eventKind10002).toBe(0.1);
    expect(result.components.reciprocity).toBe(0.05);
  });

  test("should validate input parameters", () => {
    expect(() => calculator.calculate("", "target", testMetrics, 1)).toThrow();
    expect(() => calculator.calculate("source", "", testMetrics, 1)).toThrow();
    expect(() =>
      calculator.calculate("source", "target", null as any, 1),
    ).toThrow();
    expect(() =>
      calculator.calculate("source", "target", testMetrics, -1),
    ).toThrow();
  });

  test("should handle edge case with zero metrics", () => {
    const zeroMetrics: ProfileMetrics = {
      pubkey: "zero_metrics",
      nip05Valid: 0,
      lightningAddress: 0,
      eventKind10002: 0,
      reciprocity: 0,
      computedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const sourcePubkey = "edge_case_source";
    const targetPubkey = "edge_case_target";

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

describe("TrustCalculator - Weight Validation", () => {
  test("should accept weights that sum to 1.0", () => {
    const validConfig = {
      ...testConfig,
      weights: {
        distanceWeight: 0.5,
        nip05Valid: 0.2,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.1,
      },
    };

    expect(() => new TrustCalculator(validConfig)).not.toThrow();
  });

  test("should accept weights within tolerance (±0.01)", () => {
    const validConfig = {
      ...testConfig,
      weights: {
        distanceWeight: 0.5,
        nip05Valid: 0.2,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.105, // Sum = 1.005, within tolerance
      },
    };

    expect(() => new TrustCalculator(validConfig)).not.toThrow();
  });

  test("should reject weights that sum too low", () => {
    const invalidConfig = {
      ...testConfig,
      weights: {
        distanceWeight: 0.4,
        nip05Valid: 0.2,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.1, // Sum = 0.9, outside tolerance
      },
    };

    expect(() => new TrustCalculator(invalidConfig)).toThrow(
      /must sum to 1.0/,
    );
  });

  test("should reject weights that sum too high", () => {
    const invalidConfig = {
      ...testConfig,
      weights: {
        distanceWeight: 0.5,
        nip05Valid: 0.3,
        lightningAddress: 0.2,
        eventKind10002: 0.15,
        reciprocity: 0.1, // Sum = 1.25, outside tolerance
      },
    };

    expect(() => new TrustCalculator(invalidConfig)).toThrow(
      /must sum to 1.0/,
    );
  });

  test("should validate custom weights passed to calculate()", () => {
    const invalidCustomWeights = {
      distanceWeight: 0.8,
      nip05Valid: 0.5, // This will make sum > 1.0 when merged
    };

    expect(() =>
      calculator.calculate(
        "source",
        "target",
        testMetrics,
        1,
        invalidCustomWeights,
      ),
    ).toThrow(/must sum to 1.0/);
  });

  test("should validate weights on config update", () => {
    const calc = new TrustCalculator(testConfig);
    
    const invalidWeights = {
      distanceWeight: 0.3,
      nip05Valid: 0.2,
      lightningAddress: 0.1,
      eventKind10002: 0.1,
      reciprocity: 0.1, // Sum = 0.8
    };

    expect(() => calc.updateConfig({ weights: invalidWeights })).toThrow(
      /must sum to 1.0/,
    );
  });
});

describe("TrustCalculator - Score Rounding", () => {
  test("should round score to 3 decimal places", () => {
    const result = calculator.calculate("source", "target", testMetrics, 1);
    
    // Check that score has at most 3 decimal places
    const scoreStr = result.score.toString();
    const decimalPart = scoreStr.split('.')[1] || '';
    expect(decimalPart.length).toBeLessThanOrEqual(3);
  });

  test("should round component values to 3 decimal places", () => {
    const result = calculator.calculate("source", "target", testMetrics, 2);
    
    // Check all component values
    const checkDecimalPlaces = (value: number) => {
      const valueStr = value.toString();
      const decimalPart = valueStr.split('.')[1] || '';
      expect(decimalPart.length).toBeLessThanOrEqual(3);
    };

    checkDecimalPlaces(result.components.distanceWeight);
    checkDecimalPlaces(result.components.nip05Valid);
    checkDecimalPlaces(result.components.lightningAddress);
    checkDecimalPlaces(result.components.eventKind10002);
    checkDecimalPlaces(result.components.reciprocity);
    checkDecimalPlaces(result.components.socialDistance);
    checkDecimalPlaces(result.components.normalizedDistance);
  });

  test("should maintain score accuracy after rounding", () => {
    // Use a distance that creates a long decimal
    const distance = 3.7;
    const result = calculator.calculate("source", "target", testMetrics, distance);
    
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
    expect(socialGraph.getCurrentRoot()).toBe("test_root_pubkey");
  });

  test("should throw error when created with invalid path", () => {
    expect(() => new SocialGraph("")).toThrow();
  });

  test("should get distance between pubkeys", () => {
    const distance = socialGraph.getDistance("target_pubkey_123");
    expect(typeof distance).toBe("number");
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThanOrEqual(1000);
  });

  test("should check follow relationships", () => {
    const follows = socialGraph.doesFollow("source_pubkey", "target_pubkey");
    expect(typeof follows).toBe("boolean");
  });

  test("should get graph statistics", () => {
    const stats = socialGraph.getStats();
    expect(stats).toHaveProperty("users");
    expect(stats).toHaveProperty("follows");
    expect(stats.users).toBeGreaterThanOrEqual(0);
    expect(stats.follows).toBeGreaterThanOrEqual(0);
  });

  test("should switch root pubkey", async () => {
    const newRoot = "new_root_pubkey";
    await socialGraph.switchRoot(newRoot);
    expect(socialGraph.getCurrentRoot()).toBe(newRoot);

    // Switch back for other tests
    await socialGraph.switchRoot("test_root_pubkey");
  });

  test("should validate parameters", () => {
    expect(() => socialGraph.getDistance("")).toThrow();
    expect(() => socialGraph.doesFollow("", "target")).toThrow();
    expect(() => socialGraph.doesFollow("source", "")).toThrow();
  });

  test("should throw errors when not initialized", () => {
    const uninitializedGraph = new SocialGraph("./data/socialGraph.bin");

    expect(() => uninitializedGraph.getCurrentRoot()).toThrow();
    expect(() => uninitializedGraph.getDistance("target")).toThrow();
    expect(() => uninitializedGraph.doesFollow("source", "target")).toThrow();
  });
});

describe("Integration - TrustCalculator + SocialGraph", () => {
  test("should calculate trust score using actual social graph distance", () => {
    const targetPubkey = "integration_target";
    const distance = socialGraph.getDistance(targetPubkey);

    const score = calculator.calculate(
      "test_root_pubkey",
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
