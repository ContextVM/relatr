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
        reciprocity: 0.1
    }
};

// Test data
const testMetrics: ProfileMetrics = {
    pubkey: "test_target_pubkey",
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 1.0,
    reciprocity: 0.8,
    computedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600
};

// Shared instances
let db: Database;
let cache: SimpleCache<TrustScore>;
let calculator: TrustCalculator;
let socialGraph: SocialGraph;

beforeAll(async () => {
    // Initialize database and cache
    db = new Database(":memory:");
    cache = new SimpleCache<TrustScore>("test_trust_scores", 3600);
    calculator = new TrustCalculator(testConfig, cache);
    
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
        const calc1 = new TrustCalculator(config1, cache);
        
        const config2 = { ...testConfig, decayFactor: 0.7 };
        const calc2 = new TrustCalculator(config2, cache);
        
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
    
    test("should compute correct weighted score", async () => {
        const sourcePubkey = "source_test_123";
        const targetPubkey = "target_test_456";
        const distance = 2;
        
        const result = await calculator.calculate(sourcePubkey, targetPubkey, testMetrics, distance);
        
        // Verify formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
        const normalizedDistance = Math.exp(-testConfig.decayFactor * distance);
        const weights = testConfig.weights;
        
        const weightedSum = 
            weights.distanceWeight * normalizedDistance +
            weights.nip05Valid * testMetrics.nip05Valid +
            weights.lightningAddress * testMetrics.lightningAddress +
            weights.eventKind10002 * testMetrics.eventKind10002 +
            weights.reciprocity * testMetrics.reciprocity;
        
        const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
        const expectedScore = weightedSum / totalWeight;
        
        expect(result.score).toBeCloseTo(expectedScore, 6);
    });

    test("should include all components in result", async () => {
        const result = await calculator.calculate("source", "target", testMetrics, 1);
        
        expect(result).toHaveProperty('sourcePubkey');
        expect(result).toHaveProperty('targetPubkey');
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('components');
        expect(result).toHaveProperty('computedAt');
        
        // Verify components structure
        expect(result.components).toHaveProperty('distanceWeight');
        expect(result.components).toHaveProperty('nip05Valid');
        expect(result.components).toHaveProperty('lightningAddress');
        expect(result.components).toHaveProperty('eventKind10002');
        expect(result.components).toHaveProperty('reciprocity');
        expect(result.components).toHaveProperty('socialDistance');
        expect(result.components).toHaveProperty('normalizedDistance');
    });

    test("should use cache on second call", async () => {
        const sourcePubkey = "cache_test_source";
        const targetPubkey = "cache_test_target";
        const distance = 3;
        
        // Clear cache for this test
        await cache.clear([sourcePubkey, targetPubkey]);
        
        // First call - cache miss
        const result1 = await calculator.calculate(sourcePubkey, targetPubkey, testMetrics, distance);
        
        // Second call - cache hit
        const result2 = await calculator.calculate(sourcePubkey, targetPubkey, testMetrics, distance);
        
        expect(result2.score).toBe(result1.score);
        expect(result2.computedAt).toBe(result1.computedAt);
    });

    test("should handle custom weights override", async () => {
        const customWeights = { distanceWeight: 0.5, nip05Valid: 0.3 };
        const sourcePubkey = "custom_weights_source";
        const targetPubkey = "custom_weights_target";
        
        // Clear cache to ensure fresh calculation
        await cache.clear([sourcePubkey, targetPubkey]);
        
        const result = await calculator.calculate(sourcePubkey, targetPubkey, testMetrics, 1, customWeights);
        
        // The components should show the final weights used in calculation
        expect(result.components.distanceWeight).toBe(0.5);
        expect(result.components.nip05Valid).toBe(0.3);
        expect(result.components.lightningAddress).toBe(testConfig.weights.lightningAddress);
        expect(result.components.eventKind10002).toBe(testConfig.weights.eventKind10002);
        expect(result.components.reciprocity).toBe(testConfig.weights.reciprocity);
    });

    test("should validate input parameters", async () => {
        expect(calculator.calculate("", "target", testMetrics, 1)).rejects.toThrow();
        expect(calculator.calculate("source", "", testMetrics, 1)).rejects.toThrow();
        expect(calculator.calculate("source", "target", null as any, 1)).rejects.toThrow();
        expect(calculator.calculate("source", "target", testMetrics, -1)).rejects.toThrow();
    });

    test("should handle edge case with zero metrics", async () => {
        const zeroMetrics: ProfileMetrics = {
            pubkey: "zero_metrics",
            nip05Valid: 0,
            lightningAddress: 0,
            eventKind10002: 0,
            reciprocity: 0,
            computedAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 3600
        };
        
        const sourcePubkey = "edge_case_source";
        const targetPubkey = "edge_case_target";
        
        // Clear cache to ensure fresh calculation
        await cache.clear([sourcePubkey, targetPubkey]);
        
        // With distance 1000, normalized distance is 0, so all weighted components are 0
        const result = await calculator.calculate(sourcePubkey, targetPubkey, zeroMetrics, 1000);
        expect(result.score).toBe(0);
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
        expect(stats).toHaveProperty('users');
        expect(stats).toHaveProperty('follows');
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
    
    test("should calculate trust score using actual social graph distance", async () => {
        const targetPubkey = "integration_target";
        const distance = socialGraph.getDistance(targetPubkey);
        
        const score = await calculator.calculate(
            "test_root_pubkey",
            targetPubkey,
            testMetrics,
            distance
        );
        
        expect(score).toHaveProperty('score');
        expect(score.components.socialDistance).toBe(distance);
        expect(score.components.normalizedDistance).toBeGreaterThanOrEqual(0);
        expect(score.components.normalizedDistance).toBeLessThanOrEqual(1);
    });
});