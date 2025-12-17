import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseManager } from "../database/DatabaseManager";
import { TARepository } from "../database/repositories/TARepository";
import { unlink } from "fs/promises";
import type { DuckDBConnection } from "@duckdb/node-api";

describe("TARepository", () => {
  let dbManager: DatabaseManager;
  let taRepository: TARepository;
  let connection: DuckDBConnection;

  beforeEach(async () => {
    // Initialize fresh database
    dbManager = DatabaseManager.getInstance(":memory:");
    await dbManager.initialize();
    connection = dbManager.getConnection();
    taRepository = new TARepository(connection);
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.close();
    }
  });

  describe("addSubscriber", () => {
    it("should add a new subscriber successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const subscriber = await taRepository.addSubscriber(pubkey);

      expect(subscriber.subscriberPubkey).toBe(pubkey);
      expect(subscriber.latestRank).toBeNull();
      expect(subscriber.isActive).toBe(true);
      expect(subscriber.createdAt).toBeGreaterThan(0);
      expect(subscriber.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("isSubscribed", () => {
    it("should return true for active subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addSubscriber(pubkey);

      const isSubscribed = await taRepository.isSubscribed(pubkey);
      expect(isSubscribed).toBe(true);
    });

    it("should return false for non-existent subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const isSubscribed = await taRepository.isSubscribed(pubkey);
      expect(isSubscribed).toBe(false);
    });

    it("should return false for deactivated subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addSubscriber(pubkey);
      await taRepository.deactivateSubscriber(pubkey);

      const isSubscribed = await taRepository.isSubscribed(pubkey);
      expect(isSubscribed).toBe(false);
    });
  });

  describe("getActiveSubscribers", () => {
    it("should return all active subscribers", async () => {
      const pubkey1 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const pubkey2 =
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const pubkey3 =
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

      await taRepository.addSubscriber(pubkey1);
      await taRepository.addSubscriber(pubkey2);
      await taRepository.addSubscriber(pubkey3);
      await taRepository.deactivateSubscriber(pubkey2); // Deactivate one

      const activeSubscribers = await taRepository.getActiveSubscribers();
      expect(activeSubscribers).toHaveLength(2);
      expect(activeSubscribers).toContain(pubkey1);
      expect(activeSubscribers).toContain(pubkey3);
      expect(activeSubscribers).not.toContain(pubkey2);
    });

    it("should return empty array when no active subscribers", async () => {
      const activeSubscribers = await taRepository.getActiveSubscribers();
      expect(activeSubscribers).toHaveLength(0);
    });
  });

  describe("deactivateSubscriber", () => {
    it("should deactivate subscriber successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addSubscriber(pubkey);

      await taRepository.deactivateSubscriber(pubkey);

      const isSubscribed = await taRepository.isSubscribed(pubkey);
      expect(isSubscribed).toBe(false);
    });

    it("should not throw error for non-existent subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      expect(taRepository.deactivateSubscriber(pubkey)).resolves.toBe(
        undefined,
      );
    });
  });

  describe("getSubscriber", () => {
    it("should return subscriber data for existing subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const created = await taRepository.addSubscriber(pubkey);

      const subscriber = await taRepository.getSubscriber(pubkey);
      expect(subscriber).not.toBeNull();
      expect(subscriber!.id).toBe(created.id);
      expect(subscriber!.subscriberPubkey).toBe(pubkey);
    });

    it("should return null for non-existent subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const subscriber = await taRepository.getSubscriber(pubkey);
      expect(subscriber).toBeNull();
    });
  });

  describe("updateLatestRank", () => {
    it("should update rank successfully", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      await taRepository.addSubscriber(pubkey);

      const computedAt = Math.floor(Date.now() / 1000);
      await taRepository.updateLatestRank(pubkey, 75, computedAt);

      const subscriber = await taRepository.getSubscriber(pubkey);
      expect(subscriber!.latestRank).toBe(75);
      expect(subscriber!.updatedAt).toBe(computedAt);
    });

    it("should not throw error for non-existent subscriber", async () => {
      const pubkey =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const computedAt = Math.floor(Date.now() / 1000);
      await expect(
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

      await taRepository.addSubscriber(pubkey1);
      await taRepository.addSubscriber(pubkey2);
      await taRepository.addSubscriber(pubkey3);
      await taRepository.deactivateSubscriber(pubkey2);

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
});
