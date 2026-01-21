import { describe, it, expect, beforeAll } from "bun:test";
import { DatabaseManager } from "../database/DatabaseManager";
import { MetricsRepository } from "../database/repositories/MetricsRepository";
import { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { ProfileMetrics, NostrProfile } from "../types";
import { nowMs, nowSeconds } from "@/utils/utils";

/**
 * Regression test for the "cannot start a transaction within a transaction" failure mode.
 *
 * We share a single DuckDBConnection across the app, and multiple async tasks can attempt
 * to write concurrently (scheduler sync + request path cache writes).
 *
 * The fix is to serialize writes via DbWriteQueue used by repositories.
 */
describe("DuckDB concurrency regression", () => {
  let dbManager: DatabaseManager;
  let metricsRepository: MetricsRepository;
  let metadataRepository: MetadataRepository;

  beforeAll(async () => {
    dbManager = DatabaseManager.getInstance(":memory:");
    await dbManager.initialize();
    const writeConnection = dbManager.getWriteConnection();
    const readConnection = dbManager.getReadConnection();

    metricsRepository = new MetricsRepository(
      readConnection,
      writeConnection,
      60,
    ); // small TTL for tests
    metadataRepository = new MetadataRepository(
      readConnection,
      writeConnection,
    );
  });

  it("should serialize overlapping metrics writes without transaction nesting errors", async () => {
    const pubkeys = Array.from({ length: 25 }, (_, i) =>
      (i + 1).toString(16).padStart(64, "0"),
    );

    const makeMetrics = (pubkey: string, n: number): ProfileMetrics => ({
      pubkey,
      metrics: {
        nip05Valid: n % 2,
        lightningAddress: (n % 3) / 2,
        eventKind10002: (n % 5) / 4,
        reciprocity: (n % 7) / 6,
      },
      computedAt: nowSeconds(),
      expiresAt: nowSeconds() + 60,
    });

    // Deliberately overlap:
    // - multiple saveBatch calls (each has BEGIN/COMMIT internally)
    // - multiple save calls (also BEGIN/COMMIT)
    // If writes are not serialized, this commonly triggers nested transaction errors.
    const batch1 = pubkeys.slice(0, 10).map((pk, i) => makeMetrics(pk, i));
    const batch2 = pubkeys
      .slice(5, 15)
      .map((pk, i) => makeMetrics(pk, i + 100));
    const batch3 = pubkeys
      .slice(10, 20)
      .map((pk, i) => makeMetrics(pk, i + 200));

    const overlapping = [
      metricsRepository.saveBatch(batch1),
      metricsRepository.saveBatch(batch2),
      metricsRepository.saveBatch(batch3),
      ...pubkeys.map((pk, i) =>
        metricsRepository.save(pk, makeMetrics(pk, i + 300)),
      ),
    ];

    // We only care that nothing throws.
    await expect(Promise.all(overlapping)).resolves.toBeDefined();
  });

  it("should serialize overlapping metadata writes (delete+insert) without errors", async () => {
    const profiles: NostrProfile[] = Array.from({ length: 100 }, (_, i) => ({
      pubkey: (i + 1).toString(16).padStart(64, "a"),
      name: `name_${i}`,
      display_name: `display_${i}`,
      nip05: `user${i}@example.com`,
      lud16: `user${i}@ln.example.com`,
      about: `about_${i}`,
    }));

    const overlapping = [
      metadataRepository.saveMany(profiles.slice(0, 60)),
      metadataRepository.saveMany(profiles.slice(40, 100)),
      ...profiles.slice(0, 25).map((p) => metadataRepository.save(p)),
    ];
    await expect(Promise.all(overlapping)).resolves.toBeDefined();
  });

  it("should allow concurrent reads while writes are happening", async () => {
    const writeConnection = dbManager.getWriteConnection();
    const readConnection = dbManager.getReadConnection();

    // Insert some test data
    const testProfile: NostrProfile = {
      pubkey: "aa".repeat(32),
      name: "Test User",
      display_name: "Test Display",
      nip05: "test@example.com",
      lud16: "test@ln.example.com",
      about: "Test user for concurrency testing",
    };

    await metadataRepository.save(testProfile);

    // Start a long-running write transaction
    const longWritePromise = (async () => {
      await writeConnection.run("BEGIN TRANSACTION");
      // Simulate a long write operation
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeConnection.run("COMMIT");
    })();

    // Concurrent reads should not be blocked
    const readStartTime = nowMs();
    const readPromise = (async () => {
      const result = await readConnection.run(
        "SELECT * FROM pubkey_metadata WHERE pubkey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
      );
      return result.getRows();
    })();

    // Wait for both to complete
    await Promise.all([longWritePromise, readPromise]);
    const readEndTime = nowMs();
    const readDuration = readEndTime - readStartTime;

    // Read should complete quickly (not blocked by write)
    expect(readDuration).toBeLessThan(200); // Should complete in < 200ms even with 100ms write
  });

  it("should serialize writes but allow concurrent reads", async () => {
    const readConnection = dbManager.getReadConnection();
    const profiles: NostrProfile[] = Array.from({ length: 50 }, (_, i) => ({
      pubkey: (i + 1000).toString(16).padStart(64, "b"),
      name: `concurrent_${i}`,
      display_name: `Concurrent ${i}`,
      nip05: `user${i}@concurrent.com`,
      lud16: `user${i}@ln.concurrent.com`,
      about: `About concurrent user ${i}`,
    }));

    // Start multiple write operations (should be serialized)
    const writePromises = [
      metadataRepository.saveMany(profiles.slice(0, 25)),
      metadataRepository.saveMany(profiles.slice(25, 50)),
    ];

    // Start concurrent read operations (should not be blocked)
    const readPromises = Array.from({ length: 10 }, async (_) => {
      const result = await readConnection.run(
        `SELECT COUNT(*) as count FROM pubkey_metadata WHERE name LIKE 'concurrent_%'`,
      );
      const rows = await result.getRows();
      return rows[0];
    });

    // All should complete without errors
    await expect(Promise.all(writePromises)).resolves.toBeDefined();
    await expect(Promise.all(readPromises)).resolves.toBeDefined();
  });
});
