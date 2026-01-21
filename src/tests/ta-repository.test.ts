import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseManager } from "../database/DatabaseManager";
import { TARepository } from "../database/repositories/TARepository";
import { nowSeconds } from "@/utils/utils";

describe("TARepository", () => {
  let dbManager: DatabaseManager;
  let taRepository: TARepository;

  beforeEach(async () => {
    // Initialize fresh database
    dbManager = DatabaseManager.getInstance(":memory:");
    await dbManager.initialize();
    const writeConnection = dbManager.getWriteConnection();
    const readConnection = dbManager.getReadConnection();
    taRepository = new TARepository(readConnection, writeConnection);
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.close();
    }
  });

  describe("addTA", () => {
    it("should add a new user successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const user = await taRepository.addTA(pubkey);

      expect(user.pubkey).toBe(pubkey);
      expect(user.latestRank).toBeNull();
      expect(user.isActive).toBe(true);
      expect(user.createdAt).toBeGreaterThan(0);
      expect(user.computedAt).toBeGreaterThan(0);
    });
  });

  describe("isActive", () => {
    it("should return true for active user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addTA(pubkey);

      const isActive = await taRepository.isActive(pubkey);
      expect(isActive).toBe(true);
    });

    it("should return false for non-existent user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const isActive = await taRepository.isActive(pubkey);
      expect(isActive).toBe(false);
    });

    it("should return false for deactivated user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addTA(pubkey);
      await taRepository.disableTA(pubkey);

      const isActive = await taRepository.isActive(pubkey);
      expect(isActive).toBe(false);
    });
  });

  describe("disableTA", () => {
    it("should deactivate user successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addTA(pubkey);

      await taRepository.disableTA(pubkey);

      const isActive = await taRepository.isActive(pubkey);
      expect(isActive).toBe(false);
    });

    it("should not throw error for non-existent user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      expect(taRepository.disableTA(pubkey)).resolves.toBe(undefined);
    });
  });

  describe("getTA", () => {
    it("should return user data for existing user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const created = await taRepository.addTA(pubkey);

      const user = await taRepository.getTA(pubkey);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(created.id);
      expect(user!.pubkey).toBe(pubkey);
    });

    it("should return null for non-existent user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const user = await taRepository.getTA(pubkey);
      expect(user).toBeNull();
    });
  });

  describe("updateLatestRank", () => {
    it("should update rank successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addTA(pubkey);

      const computedAt = nowSeconds();
      await taRepository.updateLatestRank(pubkey, 75, computedAt);

      const user = await taRepository.getTA(pubkey);
      expect(user!.latestRank).toBe(75);
      expect(user!.computedAt).toBe(computedAt);
    });

    it("should not throw error for non-existent user", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const computedAt = nowSeconds();
      expect(
        taRepository.updateLatestRank(pubkey, 75, computedAt),
      ).rejects.toThrow();
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const pubkey3 =
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

      await taRepository.addTA(pubkey1);
      await taRepository.addTA(pubkey2);
      await taRepository.addTA(pubkey3);
      await taRepository.disableTA(pubkey2);

      const stats = await taRepository.getStats();
      expect(stats.total).toBe(3);
      expect(stats.active).toBe(2);
    });

    it("should return zero stats for empty database", async () => {
      const stats = await taRepository.getStats();
      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  describe("getOrCreateTA", () => {
    it("should create new user when not exists", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      const user = await taRepository.getOrCreateTA(pubkey, true);

      expect(user.pubkey).toBe(pubkey);
      expect(user.isActive).toBe(true);
      expect(user.latestRank).toBeNull();
      expect(user.createdAt).toBeGreaterThan(0);
      expect(user.computedAt).toBeGreaterThan(0);
    });

    it("should return existing user when exists", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      const created = await taRepository.addTA(pubkey);
      const retrieved = await taRepository.getOrCreateTA(pubkey, false);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.pubkey).toBe(pubkey);
      // Should preserve original isActive state
      expect(retrieved.isActive).toBe(true);
    });

    it("should create with isActive=false when specified", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      const user = await taRepository.getOrCreateTA(pubkey, false);

      expect(user.isActive).toBe(false);
    });

    it("should default to isActive=false when not specified", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      const user = await taRepository.getOrCreateTA(pubkey);

      expect(user.isActive).toBe(false);
    });
  });

  describe("getStaleActiveTA", () => {
    it("should return active users with computed_at before threshold", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const pubkey3 =
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

      await taRepository.addTA(pubkey1);
      await taRepository.addTA(pubkey2);
      await taRepository.addTA(pubkey3);

      // Update pubkey1 to make it fresh
      await taRepository.updateLatestRank(pubkey1, 75, nowSeconds());

      // pubkey2 and pubkey3 remain stale (default computed_at from addTA)
      const now = nowSeconds();
      const staleThreshold = now + 3600; // 1 hour in the future (all are stale)

      const staleEntries = await taRepository.getStaleActiveTA(staleThreshold);
      expect(staleEntries).toHaveLength(3);
      const stalePubkeys = staleEntries.map((s) => s.pubkey);
      expect(stalePubkeys).toContain(pubkey1);
      expect(stalePubkeys).toContain(pubkey2);
      expect(stalePubkeys).toContain(pubkey3);
    });

    it("should return empty array when no stale active users", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      await taRepository.addTA(pubkey);
      await taRepository.updateLatestRank(pubkey, 75, nowSeconds());

      const now = nowSeconds();
      const staleThreshold = now - 3600; // 1 hour ago (none are stale)

      const staleEntries = await taRepository.getStaleActiveTA(staleThreshold);
      expect(staleEntries).toHaveLength(0);
    });

    it("should be ordered by computed_at asc for active users", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const pubkey3 =
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

      await taRepository.addTA(pubkey1);
      await taRepository.addTA(pubkey2);
      await taRepository.addTA(pubkey3);

      const now = nowSeconds();
      const staleThreshold = now + 3600; // 1 hour in the future (all are stale)

      const staleEntries = await taRepository.getStaleActiveTA(staleThreshold);
      expect(staleEntries).toHaveLength(3);
      // Should be ordered by computed_at asc (oldest first)
      expect(staleEntries[0]?.pubkey).toBe(pubkey1);
      expect(staleEntries[1]?.pubkey).toBe(pubkey2);
      expect(staleEntries[2]?.pubkey).toBe(pubkey3);
    });
  });

  describe("updateLatestRanksBatch", () => {
    it("should update multiple ranks in a single transaction", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const pubkey3 =
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

      await taRepository.addTA(pubkey1);
      await taRepository.addTA(pubkey2);
      await taRepository.addTA(pubkey3);

      const now = nowSeconds();
      const updates = [
        { pubkey: pubkey1, rank: 75, computedAt: now },
        { pubkey: pubkey2, rank: 50, computedAt: now },
        { pubkey: pubkey3, rank: 90, computedAt: now },
      ];

      await taRepository.updateLatestRanksBatch(updates);

      const user1 = await taRepository.getTA(pubkey1);
      const user2 = await taRepository.getTA(pubkey2);
      const user3 = await taRepository.getTA(pubkey3);

      expect(user1!.latestRank).toBe(75);
      expect(user1!.computedAt).toBe(now);
      expect(user2!.latestRank).toBe(50);
      expect(user2!.computedAt).toBe(now);
      expect(user3!.latestRank).toBe(90);
      expect(user3!.computedAt).toBe(now);
    });

    it("should handle empty updates array", async () => {
      await expect(
        taRepository.updateLatestRanksBatch([]),
      ).resolves.toBeUndefined();
    });

    it("should silently skip non-existent users", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

      await taRepository.addTA(pubkey1);

      const now = nowSeconds();
      const updates = [
        { pubkey: pubkey1, rank: 75, computedAt: now },
        { pubkey: pubkey2, rank: 50, computedAt: now }, // doesn't exist
      ];

      // Should not throw - SQL UPDATE silently skips non-existent rows
      await expect(
        taRepository.updateLatestRanksBatch(updates),
      ).resolves.toBeUndefined();

      // pubkey1 should be updated
      const user1 = await taRepository.getTA(pubkey1);
      expect(user1!.latestRank).toBe(75);

      // pubkey2 should not exist
      const user2 = await taRepository.getTA(pubkey2);
      expect(user2).toBeNull();
    });
  });
});
