import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SocialGraph } from "../graph/SocialGraph";
import { loadConfig } from "../config";
import { DatabaseManager } from "../database/DatabaseManager";

/**
 * Social Graph Benchmark Tests
 * Tests for performance and functionality of the new nostr-social-duck library
 */
describe("SocialGraph - Benchmark Tests", () => {
  let socialGraph: SocialGraph;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    // Load configuration to get real root pubkey
    config = loadConfig();

    // Initialize DuckDB connection and social graph with temporary database
    const dbManager = DatabaseManager.getInstance(":memory:");
    await dbManager.initialize();
    const db = dbManager.getWriteConnection();

    // Initialize social graph with shared connection
    socialGraph = new SocialGraph(db);
    await socialGraph.initialize(config.defaultSourcePubkey);
  });

  afterAll(async () => {
    await socialGraph?.cleanup();
  });

  test("should initialize DuckDB analyzer and get all pubkeys", async () => {
    const startTime = performance.now();

    // Get all unique pubkeys from the graph
    const allPubkeys = await socialGraph.getAllUsersInGraph();
    const endTime = performance.now();

    console.log(
      `[Benchmark] getAllUsersInGraph took ${(endTime - startTime).toFixed(2)}ms`,
    );
    console.log(`[Benchmark] Found ${allPubkeys.length} pubkeys in graph`);
  });

  test("should perform random distance measurements efficiently", async () => {
    // Get all pubkeys for sampling
    const allPubkeys = await socialGraph.getAllUsersInGraph();

    if (allPubkeys.length < 2) {
      console.log("[Benchmark] Not enough pubkeys for distance measurements");
      return;
    }

    // Sample up to 10 random pubkey pairs for distance measurements
    const sampleSize = Math.min(25, Math.floor(allPubkeys.length / 2));
    const measurements: Array<{
      source: string;
      target: string;
      distance: number;
      time: number;
    }> = [];

    const startTime = performance.now();

    for (let i = 0; i < sampleSize; i++) {
      const sourceIndex = i;
      const targetIndex = (i + 1) % allPubkeys.length;

      const sourcePubkey = allPubkeys[sourceIndex]!;
      const targetPubkey = allPubkeys[targetIndex]!;

      const measurementStart = performance.now();
      const distance = await socialGraph.getDistanceBetween(
        sourcePubkey,
        targetPubkey,
      );
      const measurementEnd = performance.now();
      if (distance === 3)
        console.log("Distance is 3", sourcePubkey, targetPubkey);
      measurements.push({
        source: sourcePubkey,
        target: targetPubkey,
        distance,
        time: measurementEnd - measurementStart,
      });
    }

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    // Validate measurements
    measurements.forEach((measurement) => {
      expect(typeof measurement.distance).toBe("number");
      expect(measurement.distance).toBeGreaterThanOrEqual(0);
      expect(measurement.distance).toBeLessThanOrEqual(1000);
      expect(measurement.time).toBeGreaterThan(0);
    });

    console.log(
      `[Benchmark] ${measurements.length} distance measurements took ${totalTime.toFixed(2)}ms`,
    );
    console.log(
      `[Benchmark] Average time per measurement: ${(totalTime / measurements.length).toFixed(2)}ms`,
    );

    // Log some statistics
    const validDistances = measurements.filter((m) => m.distance < 1000);
    if (validDistances.length > 0) {
      const avgDistance =
        validDistances.reduce((sum, m) => sum + m.distance, 0) /
        validDistances.length;
      console.log(
        `[Benchmark] Average valid distance: ${avgDistance.toFixed(2)} hops`,
      );
    }

    console.log(
      `[Benchmark] ${validDistances.length}/${measurements.length} valid distances found`,
    );
  });

  test("should handle non-existent pubkeys gracefully in distance calculations", async () => {
    const nonExistentPubkey1 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const nonExistentPubkey2 =
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    const startTime = performance.now();
    const distance = await socialGraph.getDistanceBetween(
      nonExistentPubkey1,
      nonExistentPubkey2,
    );
    const endTime = performance.now();

    expect(distance).toBe(1000); // Should return max distance for non-existent pubkeys
    console.log(
      `[Benchmark] Non-existent pubkey distance check took ${(endTime - startTime).toFixed(2)}ms`,
    );
  });
});
