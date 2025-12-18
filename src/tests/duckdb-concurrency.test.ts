import { describe, it, expect, beforeAll } from "bun:test";
import { DatabaseManager } from "../database/DatabaseManager";
import { MetricsRepository } from "../database/repositories/MetricsRepository";
import { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { ProfileMetrics, NostrProfile } from "../types";

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
    const connection = dbManager.getConnection();

    metricsRepository = new MetricsRepository(connection, 60); // small TTL for tests
    metadataRepository = new MetadataRepository(connection);
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
      computedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    // Deliberately overlap:
    // - multiple saveBatch calls (each has BEGIN/COMMIT internally)
    // - multiple save calls (also BEGIN/COMMIT)
    // If writes are not serialized, this commonly triggers nested transaction errors.
    const batch1 = pubkeys.slice(0, 10).map((pk, i) => makeMetrics(pk, i));
    const batch2 = pubkeys.slice(5, 15).map((pk, i) => makeMetrics(pk, i + 100));
    const batch3 = pubkeys.slice(10, 20).map((pk, i) => makeMetrics(pk, i + 200));

    const overlapping = [
      metricsRepository.saveBatch(batch1),
      metricsRepository.saveBatch(batch2),
      metricsRepository.saveBatch(batch3),
      ...pubkeys.map((pk, i) => metricsRepository.save(pk, makeMetrics(pk, i + 300))),
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
});