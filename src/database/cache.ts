import { Database } from "bun:sqlite";
import { CacheError } from "../types";
import type { CacheKey, CacheEntry } from "../types";

/**
 * Generic cache implementation using persistent database
 * @template T - Type of cached values
 */
export class SimpleCache<T> {
  private db: Database;
  private tableName: string;
  private ttlSeconds: number;
  private getQuery: any;
  private setQuery: any;
  private setCustomTTLQuery: any;
  private deleteQuery: any;
  private deleteAllQuery: any;
  private cleanupQuery: any;

  /**
   * Create a new SimpleCache instance with persistent database
   * @param db - Database instance to use for caching
   * @param tableName - Name of the cache table
   * @param ttlSeconds - Time to live for cache entries in seconds
   */
  constructor(db: Database, tableName: string, ttlSeconds: number) {
    // Use the provided database instance for consistency
    this.db = db;
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;

    // Initialize cache table
    this.initializeTable();

    // Prepare statements for better performance
    this.prepareStatements();
  }

  /**
   * Initialize cache table with proper schema
   * @private
   */
  private initializeTable(): void {
    // Known schema tables don't need initialization
    const knownTables = new Set([
      "profile_metrics",
      "pubkey_metadata",
      "search_results",
    ]);
    if (knownTables.has(this.tableName)) {
      return;
    }

    const createTableSQL = `
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires ON ${this.tableName}(expires_at);
        `;

    try {
      this.db.run(createTableSQL);
    } catch (error) {
      throw new CacheError(
        `Failed to initialize cache table ${this.tableName}: ${error instanceof Error ? error.message : String(error)}`,
        "INIT_TABLE",
      );
    }
  }

  /**
   * Prepare commonly used statements for better performance
   * @private
   */
  private prepareStatements(): void {
    try {
      // Handle different table schemas
      if (this.tableName === "profile_metrics") {
        this.getQuery = this.db.query(`
                    SELECT pubkey as key,
                           json_object(
                               'pubkey', pubkey,
                               'nip05Valid', nip05_valid,
                               'lightningAddress', lightning_address,
                               'eventKind10002', event_kind_10002,
                               'reciprocity', reciprocity,
                               'computedAt', computed_at,
                               'expiresAt', expires_at
                           ) as value
                    FROM profile_metrics
                    WHERE pubkey = ? AND expires_at > ?
                `);

        this.setQuery = this.db.query(`
                    INSERT OR REPLACE INTO profile_metrics
                    (pubkey, nip05_valid, lightning_address, event_kind_10002, reciprocity, computed_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);

        this.deleteQuery = this.db.query(
          `DELETE FROM profile_metrics WHERE pubkey = ?`,
        );
        this.deleteAllQuery = this.db.query(`DELETE FROM profile_metrics`);
        this.cleanupQuery = this.db.query(
          `DELETE FROM profile_metrics WHERE expires_at <= ?`,
        );
      } else if (this.tableName === "pubkey_metadata") {
        this.getQuery = this.db.query(`
                    SELECT pubkey as key,
                           json_object(
                               'pubkey', pubkey,
                               'name', name,
                               'display_name', display_name,
                               'picture', picture,
                               'nip05', nip05,
                               'lud16', lud16,
                               'about', about
                           ) as value
                    FROM pubkey_metadata
                    WHERE pubkey = ? AND expires_at > ?
                `);

        this.setQuery = this.db.query(`
                    INSERT OR REPLACE INTO pubkey_metadata
                    (pubkey, name, display_name, picture, nip05, lud16, about, expires_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

        this.deleteQuery = this.db.query(
          `DELETE FROM pubkey_metadata WHERE pubkey = ?`,
        );
        this.deleteAllQuery = this.db.query(`DELETE FROM pubkey_metadata`);
        this.cleanupQuery = this.db.query(
          `DELETE FROM pubkey_metadata WHERE expires_at <= ?`,
        );
      } else if (this.tableName === "search_results") {
        this.getQuery = this.db.query(`
                    SELECT key, pubkeys as value FROM search_results
                    WHERE key = ? AND expires_at > ?
                `);

        this.setQuery = this.db.query(`
                    INSERT OR REPLACE INTO search_results (key, pubkeys, expires_at, created_at)
                    VALUES (?, ?, ?, ?)
                `);

        this.deleteQuery = this.db.query(
          `DELETE FROM search_results WHERE key = ?`,
        );
        this.deleteAllQuery = this.db.query(`DELETE FROM search_results`);
        this.cleanupQuery = this.db.query(
          `DELETE FROM search_results WHERE expires_at <= ?`,
        );
      } else {
        // Generic cache table (for future use)
        this.getQuery = this.db.query(`
                    SELECT value FROM ${this.tableName}
                    WHERE key = ? AND expires_at > ?
                `);

        this.setQuery = this.db.query(`
                    INSERT OR REPLACE INTO ${this.tableName} (key, value, expires_at, created_at)
                    VALUES (?, ?, ?, ?)
                `);

        this.deleteQuery = this.db.query(
          `DELETE FROM ${this.tableName} WHERE key = ?`,
        );
        this.deleteAllQuery = this.db.query(`DELETE FROM ${this.tableName}`);
        this.cleanupQuery = this.db.query(
          `DELETE FROM ${this.tableName} WHERE expires_at <= ?`,
        );

        // Prepare custom TTL query for generic tables
        this.setCustomTTLQuery = this.db.query(`
          INSERT OR REPLACE INTO ${this.tableName} (key, value, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `);
      }
    } catch (error) {
      throw new CacheError(
        `Failed to prepare cache statements: ${error instanceof Error ? error.message : String(error)}`,
        "PREPARE_STATEMENTS",
      );
    }
  }

  /**
   * Convert cache key to string representation
   * @param key - Cache key (string or tuple)
   * @returns String representation of key
   * @private
   */
  private keyToString(key: CacheKey): string {
    if (Array.isArray(key)) {
      return key.join(":");
    }
    return key;
  }

  /**
   * Get value from cache
   * @param key - Cache key
   * @returns Cached value or null if not found/expired
   */
  async get(key: CacheKey): Promise<T | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      let result;

      // Profile metrics and generic cache use string keys
      const keyStr = this.keyToString(key);
      result = this.getQuery.get(keyStr, now) as { value: string } | undefined;

      if (!result) {
        return null;
      }

      // Deserialize value
      return JSON.parse(result.value) as T;
    } catch (error) {
      throw new CacheError(
        `Failed to get cache value for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "GET",
      );
    }
  }

  /**
   * Set value in cache
   * @param key - Cache key
   * @param value - Value to cache
   */
  async set(key: CacheKey, value: T): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + this.ttlSeconds;

      // Validate input value
      if (value === null || value === undefined) {
        throw new Error("Cannot cache null or undefined value");
      }

      if (this.tableName === "profile_metrics") {
        // Handle profile metrics with specific schema
        const metrics = value as any;
        const keyStr = this.keyToString(key);
        this.setQuery.run(
          keyStr,
          metrics.nip05Valid || 0,
          metrics.lightningAddress || 0,
          metrics.eventKind10002 || 0,
          metrics.reciprocity || 0,
          now,
          expiresAt,
        );
      } else if (this.tableName === "pubkey_metadata") {
        // Handle pubkey metadata with specific schema
        const profile = value as any;
        const keyStr = this.keyToString(key);
        this.setQuery.run(
          keyStr,
          profile.name || null,
          profile.display_name || null,
          profile.picture || null,
          profile.nip05 || null,
          profile.lud16 || null,
          profile.about || null,
          expiresAt,
          now,
        );
      } else {
        // Generic cache handling (including search_results)
        const keyStr = this.keyToString(key);
        const serializedValue = JSON.stringify(value);

        // Validate serialized value
        if (
          !serializedValue ||
          serializedValue === "null" ||
          serializedValue === "undefined"
        ) {
          throw new Error(`Serialization failed: ${serializedValue}`);
        }

        this.setQuery.run(keyStr, serializedValue, expiresAt, now);
      }
    } catch (error) {
      throw new CacheError(
        `Failed to set cache value for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "SET",
      );
    }
  }

  /**
   * Clear cache entry by key
   * @param key - Cache key to clear (optional, if not provided clears all)
   * @returns Number of entries deleted
   */
  async clear(key?: CacheKey): Promise<number> {
    try {
      if (key) {
        // Profile metrics and generic cache use string keys
        const keyStr = this.keyToString(key);
        const result = this.deleteQuery.run(keyStr);
        return result.changes || 0;
      } else {
        const result = this.deleteAllQuery.run();
        return result.changes || 0;
      }
    } catch (error) {
      throw new CacheError(
        `Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`,
        "CLEAR",
      );
    }
  }

  /**
   * Clean up expired entries
   * @returns Number of entries deleted
   */
  async cleanup(): Promise<number> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const result = this.cleanupQuery.run(now);
      return result.changes || 0;
    } catch (error) {
      throw new CacheError(
        `Failed to cleanup expired cache entries: ${error instanceof Error ? error.message : String(error)}`,
        "CLEANUP",
      );
    }
  }

  /**
   * Get cache statistics
   * @returns Object with cache statistics
   */
  async getStats(): Promise<{
    totalEntries: number;
    expiredEntries: number;
    hitRate: number;
    lastCleanup: number;
  }> {
    try {
      const now = Math.floor(Date.now() / 1000);

      // Count total entries
      const totalQuery = this.db.query(
        `SELECT COUNT(*) as count FROM ${this.tableName}`,
      );
      const totalResult = totalQuery.get() as { count: number };

      // Count expired entries
      const expiredQuery = this.db.query(`
                SELECT COUNT(*) as count FROM ${this.tableName} 
                WHERE expires_at <= $now
            `);
      const expiredResult = expiredQuery.get({ now }) as { count: number };

      return {
        totalEntries: totalResult.count,
        expiredEntries: expiredResult.count,
        hitRate: 0, // Would need to track hits/misses separately
        lastCleanup: now,
      };
    } catch (error) {
      throw new CacheError(
        `Failed to get cache stats: ${error instanceof Error ? error.message : String(error)}`,
        "GET_STATS",
      );
    }
  }

  /**
   * Check if cache has a valid entry for key
   * @param key - Cache key
   * @returns True if key exists and is not expired
   */
  async has(key: CacheKey): Promise<boolean> {
    try {
      const value = await this.get(key);
      return value !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get or set value with factory function
   * @param key - Cache key
   * @param factory - Function to create value if not in cache
   * @returns Value from cache or factory
   */
  async getOrSet(key: CacheKey, factory: () => Promise<T>): Promise<T> {
    try {
      // Try to get from cache first
      const cached = await this.get(key);
      if (cached !== null) {
        return cached;
      }

      // Create new value and cache it
      const value = await factory();
      await this.set(key, value);
      return value;
    } catch (error) {
      throw new CacheError(
        `Failed to get or set cache value for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_OR_SET",
      );
    }
  }

  /**
   * Set value with custom TTL
   * @param key - Cache key
   * @param value - Value to cache
   * @param customTtlSeconds - Custom TTL in seconds
   */
  async setWithTTL(
    key: CacheKey,
    value: T,
    customTtlSeconds: number,
  ): Promise<void> {
    try {
      const keyStr = this.keyToString(key);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + customTtlSeconds;

      // Serialize value
      const serializedValue = JSON.stringify(value);

      // Use pre-prepared query for better performance
      this.setCustomTTLQuery.run(keyStr, serializedValue, expiresAt, now);
    } catch (error) {
      throw new CacheError(
        `Failed to set cache value with custom TTL for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "SET_WITH_TTL",
      );
    }
  }
}
