/**
 * @file Data store implementation using DuckDB
 * This replaces the SQLite-based implementation with DuckDB
 */
import { DuckDBConnection } from "@duckdb/node-api";
import { DataStoreError } from "../types";
import type { DataStoreKey } from "../types";

/**
 * Generic data store implementation using DuckDB
 * @template T - Type of cached values
 */
export class DataStore<T> {
  private connection: DuckDBConnection;
  private tableName: string;
  private ttlSeconds?: number;

  /**
   * Create a new DataStore instance with DuckDB
   * @param connection - DuckDBConnection instance to use for caching
   * @param tableName - Name of the cache table
   * @param ttlSeconds - Time to live for cache entries in seconds
   */
  constructor(
    connection: DuckDBConnection,
    tableName: string,
    ttlSeconds?: number,
  ) {
    this.connection = connection;
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Convert cache key to string representation
   * @param key - Cache key (string or tuple)
   * @returns String representation of key
   * @private
   */
  private keyToString(key: DataStoreKey): string {
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
  async get(key: DataStoreKey): Promise<T | null> {
    try {
      const keyStr = this.keyToString(key);
      const now = Math.floor(Date.now() / 1000);

      let result;
      if (this.tableName === "pubkey_metadata") {
        result = await this.connection.run(
          `
          SELECT pubkey as key,
                 json_object(
                   'pubkey', pubkey,
                   'name', name,
                   'display_name', display_name,
                   'nip05', nip05,
                   'lud16', lud16,
                   'about', about
                 ) as value
          FROM pubkey_metadata
          WHERE pubkey = $1
        `,
          { 1: keyStr },
        );
      } else if (this.tableName === "profile_metrics") {
        result = await this.connection.run(
          `
          SELECT pubkey as key,
                 json_object(
                   'pubkey', pubkey,
                   'metrics', json_group_object(metric_key, metric_value),
                   'computedAt', computed_at,
                   'expiresAt', expires_at
                 ) as value
          FROM profile_metrics
          WHERE pubkey = $1 AND expires_at > $2
          GROUP BY pubkey, computed_at, expires_at
        `,
          { 1: keyStr, 2: now },
        );
      } else {
        result = await this.connection.run(
          `
          SELECT value FROM ${this.tableName}
          WHERE key = $1 AND expires_at > $2
        `,
          { 1: keyStr, 2: now },
        );
      }

      const rows = (result as any).rows || [];
      const row = rows[0];
      return row ? (JSON.parse(row.value) as T) : null;
    } catch (error) {
      throw new DataStoreError(
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
  async set(key: DataStoreKey, value: T): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + (this.ttlSeconds ?? 604800); // 1 week TTL by default

      // Validate input value
      if (value === null || value === undefined) {
        throw new Error("Cannot cache null or undefined value");
      }

      if (this.tableName === "profile_metrics") {
        // Handle profile metrics with normalized schema
        const metrics = value as any;
        const keyStr = this.keyToString(key);

        // Delete existing metrics for this pubkey to avoid duplicates
        await this.connection.run(
          `DELETE FROM profile_metrics WHERE pubkey = $1`,
          { 1: keyStr },
        );

        // Insert each metric as a separate row
        const metricEntries = metrics.metrics || {};
        for (const [metricKey, metricValue] of Object.entries(metricEntries)) {
          if (typeof metricValue === "number") {
            await this.connection.run(
              `INSERT INTO profile_metrics (pubkey, metric_key, metric_value, computed_at, expires_at)
               VALUES ($1, $2, $3, $4, $5)`,
              { 1: keyStr, 2: metricKey, 3: metricValue, 4: now, 5: expiresAt },
            );
          }
        }
      } else if (this.tableName === "pubkey_metadata") {
        // Handle pubkey metadata with FTS table
        const profile = value as any;
        const keyStr = this.keyToString(key);

        // Delete existing entry first, then insert new one
        await this.connection.run(
          `DELETE FROM pubkey_metadata WHERE pubkey = $1`,
          { 1: keyStr },
        );
        await this.connection.run(
          `INSERT INTO pubkey_metadata (pubkey, name, display_name, nip05, lud16, about, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          {
            1: keyStr,
            2: profile.name || null,
            3: profile.display_name || null,
            4: profile.nip05 || null,
            5: profile.lud16 || null,
            6: profile.about || null,
            7: now,
          },
        );
      } else {
        // Generic cache handling
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

        await this.connection.run(
          `INSERT OR REPLACE INTO ${this.tableName} (key, value, expires_at, created_at)
           VALUES ($1, $2, $3, $4)`,
          { 1: keyStr, 2: serializedValue, 3: expiresAt, 4: now },
        );
      }
    } catch (error) {
      throw new DataStoreError(
        `Failed to set cache value for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "SET",
      );
    }
  }

  /**
   * Batch set values in cache (optimized for DuckDB)
   * @param entries - Array of key-value pairs to set
   */
  async batchSet(
    entries: Array<{ key: DataStoreKey; value: T }>,
  ): Promise<void> {
    if (this.tableName !== "pubkey_metadata") {
      throw new DataStoreError(
        "batchSet is currently only supported for pubkey_metadata table",
        "INVALID_OPERATION",
      );
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      // Deduplicate entries by key, keeping the last one
      const uniqueEntries = new Map<string, T>();
      for (const { key, value } of entries) {
        uniqueEntries.set(this.keyToString(key), value);
      }

      // Prepare batch insert for metadata
      const values = [];
      for (const [keyStr, value] of uniqueEntries.entries()) {
        const profile = value as any;

        values.push([
          keyStr,
          profile.name || null,
          profile.display_name || null,
          profile.nip05 || null,
          profile.lud16 || null,
          profile.about || null,
          now,
        ]);
      }

      // Delete existing entries first
      const pubkeys = Array.from(uniqueEntries.keys());
      const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(",");
      const deleteParams: Record<string, string> = {};
      pubkeys.forEach((pubkey, i) => {
        deleteParams[(i + 1).toString()] = pubkey;
      });
      await this.connection.run(
        `DELETE FROM pubkey_metadata WHERE pubkey IN (${placeholders})`,
        deleteParams,
      );

      // Batch insert new entries
      for (const value of values) {
        await this.connection.run(
          `INSERT INTO pubkey_metadata (pubkey, name, display_name, nip05, lud16, about, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          {
            1: value[0],
            2: value[1],
            3: value[2],
            4: value[3],
            5: value[4],
            6: value[5],
            7: value[6],
          },
        );
      }
    } catch (error) {
      throw new DataStoreError(
        `Failed to batch set cache values: ${error instanceof Error ? error.message : String(error)}`,
        "BATCH_SET",
      );
    }
  }

  /**
   * Clear cache entry by key
   * @param key - Cache key to clear (optional, if not provided clears all)
   * @returns Number of entries deleted
   */
  async clear(key?: DataStoreKey): Promise<number> {
    try {
      let result;
      if (key) {
        const keyStr = this.keyToString(key);
        result = await this.connection.run(
          `DELETE FROM ${this.tableName} WHERE pubkey = $1`,
          { 1: keyStr },
        );
      } else {
        result = await this.connection.run(`DELETE FROM ${this.tableName}`);
      }
      // DuckDB result doesn't always return rowsChanged for DELETE, but we can assume success if no error
      return 0;
    } catch (error) {
      throw new DataStoreError(
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
      let result;

      // FTS tables don't have expires_at, so handle differently
      if (this.tableName === "pubkey_metadata") {
        // Don't delete metadata entries
        return 0;
      } else {
        const now = Math.floor(Date.now() / 1000);
        result = await this.connection.run(
          `DELETE FROM ${this.tableName} WHERE expires_at <= $1`,
          { 1: now },
        );
      }

      return 0;
    } catch (error) {
      throw new DataStoreError(
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
    lastCleanup: number;
  }> {
    try {
      const now = Math.floor(Date.now() / 1000);

      // Count total entries
      const totalResult = await this.connection.run(
        `SELECT COUNT(*) as count FROM ${this.tableName}`,
      );
      const totalRows = await totalResult.getRows();
      const totalEntries = Number((totalRows[0] as any)?.count || 0);

      // Count expired entries (FTS tables don't have expires_at)
      let expiredEntries = 0;
      if (this.tableName !== "pubkey_metadata") {
        const expiredResult = await this.connection.run(
          `SELECT COUNT(*) as count FROM ${this.tableName} WHERE expires_at <= $1`,
          { 1: now },
        );
        const expiredRows = await expiredResult.getRows();
        expiredEntries = Number((expiredRows[0] as any)?.count || 0);
      }

      return {
        totalEntries,
        expiredEntries,
        lastCleanup: now,
      };
    } catch (error) {
      throw new DataStoreError(
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
  async has(key: DataStoreKey): Promise<boolean> {
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
  async getOrSet(key: DataStoreKey, factory: () => Promise<T>): Promise<T> {
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
      throw new DataStoreError(
        `Failed to get or set cache value for key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_OR_SET",
      );
    }
  }

  /**
   * Get specific metric for a pubkey
   * @param pubkey - Public key
   * @param metricKey - Specific metric key to retrieve
   * @returns Metric value or null if not found/expired
   */
  async getMetric(pubkey: string, metricKey: string): Promise<number | null> {
    if (this.tableName !== "profile_metrics") {
      throw new DataStoreError(
        "getMetric is only supported for profile_metrics table",
        "INVALID_OPERATION",
      );
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await this.connection.run(
        `
        SELECT metric_value
        FROM profile_metrics
        WHERE pubkey = $1 AND metric_key = $2 AND expires_at > $3
        ORDER BY computed_at DESC
        LIMIT 1
      `,
        { 1: pubkey, 2: metricKey, 3: now },
      );

      const rows = await result.getRows();
      const row = rows[0] as any;
      return row?.metric_value ?? null;
    } catch (error) {
      throw new DataStoreError(
        `Failed to get metric ${metricKey} for pubkey ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_METRIC",
      );
    }
  }

  /**
   * Get all metrics for a pubkey
   * @param pubkey - Public key
   * @returns Object with all metrics or null if not found/expired
   */
  async getAllMetrics(pubkey: string): Promise<Record<string, number> | null> {
    if (this.tableName !== "profile_metrics") {
      throw new DataStoreError(
        "getAllMetrics is only supported for profile_metrics table",
        "INVALID_OPERATION",
      );
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await this.connection.run(
        `
        SELECT metric_key, metric_value
        FROM profile_metrics
        WHERE pubkey = $1 AND expires_at > $2
        ORDER BY computed_at DESC
      `,
        { 1: pubkey, 2: now },
      );

      const rows = await result.getRows();
      if (rows.length === 0) {
        return null;
      }

      const metrics: Record<string, number> = {};
      for (const row of rows) {
        const r = row as any;
        metrics[r.metric_key] = r.metric_value;
      }

      return metrics;
    } catch (error) {
      throw new DataStoreError(
        `Failed to get all metrics for pubkey ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_ALL_METRICS",
      );
    }
  }

  /**
   * Get metrics by key across multiple pubkeys
   * @param metricKey - Metric key to query
   * @param limit - Maximum number of results (optional)
   * @returns Array of pubkey-value pairs
   */
  async getMetricsByKey(
    metricKey: string,
    limit?: number,
  ): Promise<Array<{ pubkey: string; value: number }>> {
    if (this.tableName !== "profile_metrics") {
      throw new DataStoreError(
        "getMetricsByKey is only supported for profile_metrics table",
        "INVALID_OPERATION",
      );
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const limitClause = limit ? `LIMIT ${limit}` : "";
      const result = await this.connection.run(
        `
        SELECT DISTINCT pubkey, metric_value as value
        FROM profile_metrics
        WHERE metric_key = $1 AND expires_at > $2
        ORDER BY computed_at DESC
        ${limitClause}
      `,
        { 1: metricKey, 2: now },
      );

      const rows = await result.getRows();
      return rows.map((row) => {
        const r = row as any;
        return {
          pubkey: r.pubkey,
          value: r.value,
        };
      });
    } catch (error) {
      throw new DataStoreError(
        `Failed to get metrics by key ${metricKey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_METRICS_BY_KEY",
      );
    }
  }

  /**
   * Get pubkeys that don't have validation scores in the database
   * @param pubkeys - Array of pubkeys to check
   * @returns Array of pubkeys without validation scores
   */
  async getPubkeysWithoutValidationScores(
    pubkeys: string[],
  ): Promise<string[]> {
    if (this.tableName !== "profile_metrics") {
      throw new DataStoreError(
        "getPubkeysWithoutValidationScores is only supported for profile_metrics table",
        "INVALID_OPERATION",
      );
    }

    if (!pubkeys || pubkeys.length === 0) {
      return [];
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      // Create placeholders for the IN clause
      const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(",");
      const params: Record<string, string> = {};
      pubkeys.forEach((pubkey, i) => {
        params[(i + 1).toString()] = pubkey;
      });
      params[(pubkeys.length + 1).toString()] = now.toString();

      // Query to find pubkeys that have validation scores
      const result = await this.connection.run(
        `
        SELECT DISTINCT pubkey
        FROM profile_metrics
        WHERE pubkey IN (${placeholders}) AND expires_at > $${pubkeys.length + 1}
      `,
        params,
      );

      const rows = await result.getRows();
      const pubkeysWithScores = new Set(rows.map((row: any) => row.pubkey));

      // Return pubkeys that are NOT in the set of pubkeys with scores
      return pubkeys.filter((pubkey) => !pubkeysWithScores.has(pubkey));
    } catch (error) {
      throw new DataStoreError(
        `Failed to get pubkeys without validation scores: ${error instanceof Error ? error.message : String(error)}`,
        "GET_PUBKEYS_WITHOUT_SCORES",
      );
    }
  }
}
