import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type ProfileMetrics } from "../../types";
import { executeWithRetry } from "nostr-social-duck";

export class MetricsRepository {
  private connection: DuckDBConnection;
  private ttlSeconds: number;

  constructor(connection: DuckDBConnection, ttlSeconds: number = 604800) {
    this.connection = connection;
    this.ttlSeconds = ttlSeconds;
  }

  async save(pubkey: string, metrics: ProfileMetrics): Promise<void> {
    return executeWithRetry(async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + this.ttlSeconds;

      // Delete existing metrics for this pubkey
      await this.connection.run(
        "DELETE FROM profile_metrics WHERE pubkey = $1",
        { 1: pubkey },
      );

      // Insert new metrics
      const metricEntries = metrics.metrics || {};
      for (const [metricKey, metricValue] of Object.entries(metricEntries)) {
        if (typeof metricValue === "number") {
          await this.connection.run(
            `INSERT INTO profile_metrics (pubkey, metric_key, metric_value, computed_at, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            { 1: pubkey, 2: metricKey, 3: metricValue, 4: now, 5: expiresAt },
          );
        }
      }
    });
  }

  async get(pubkey: string): Promise<ProfileMetrics | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await this.connection.run(
        `SELECT metric_key, metric_value, computed_at, expires_at
         FROM profile_metrics
         WHERE pubkey = $1 AND expires_at > $2`,
        { 1: pubkey, 2: now },
      );

      const rows = await result.getRows();
      if (rows.length === 0) {
        return null;
      }

      const metrics: Record<string, number> = {};
      let computedAt = 0;
      let expiresAt = 0;

      for (const row of rows) {
        // DuckDB returns columns by index, not by name
        const rowArray = row as unknown[];
        const metricKey = rowArray[0] as string;
        const metricValue = rowArray[1] as number;
        const rowComputedAt = rowArray[2] as number;
        const rowExpiresAt = rowArray[3] as number;

        if (metricKey !== undefined && metricValue !== undefined) {
          metrics[metricKey] = metricValue;
        }

        // Take computed_at and expires_at from any row (they should be the same for the same pubkey)
        if (rowComputedAt) computedAt = rowComputedAt;
        if (rowExpiresAt) expiresAt = rowExpiresAt;
      }

      return {
        pubkey,
        metrics,
        computedAt,
        expiresAt,
      };
    } catch (error) {
      throw new DatabaseError(
        `Failed to get metrics for ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "METRICS_GET",
      );
    }
  }

  /**
   * Get metrics for multiple pubkeys in a single batch operation
   * @param pubkeys - Array of public keys to retrieve metrics for
   * @returns Map of pubkey to ProfileMetrics (null if not found or expired)
   */
  async getBatch(
    pubkeys: string[],
  ): Promise<Map<string, ProfileMetrics | null>> {
    if (!pubkeys || pubkeys.length === 0) {
      return new Map();
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      // Create placeholders for IN clause
      const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(",");
      const params: Record<string, string | number> = {};
      pubkeys.forEach((pubkey, i) => {
        params[(i + 1).toString()] = pubkey;
      });
      params[(pubkeys.length + 1).toString()] = now;

      const result = await this.connection.run(
        `SELECT pubkey, metric_key, metric_value, computed_at, expires_at
         FROM profile_metrics
         WHERE pubkey IN (${placeholders}) AND expires_at > $${pubkeys.length + 1}
         ORDER BY pubkey, metric_key`,
        params,
      );

      const rows = await result.getRows();
      const metricsMap = new Map<string, ProfileMetrics | null>();

      // Initialize all pubkeys with null (not found/expired)
      pubkeys.forEach((pubkey) => metricsMap.set(pubkey, null));

      // Group metrics by pubkey
      const pubkeyMetrics = new Map<string, Array<unknown[]>>();

      for (const row of rows) {
        const rowArray = row as unknown[];
        const pubkey = rowArray[0] as string;

        if (!pubkeyMetrics.has(pubkey)) {
          pubkeyMetrics.set(pubkey, []);
        }
        pubkeyMetrics.get(pubkey)!.push(rowArray);
      }

      // Build ProfileMetrics for each pubkey
      for (const [pubkey, metricRows] of pubkeyMetrics) {
        const metrics: Record<string, number> = {};
        let computedAt = 0;
        let expiresAt = 0;

        for (const row of metricRows) {
          const rowArray = row as unknown[];
          const metricKey = rowArray[1] as string;
          const metricValue = rowArray[2] as number;
          const rowComputedAt = rowArray[3] as number;
          const rowExpiresAt = rowArray[4] as number;

          if (metricKey !== undefined && metricValue !== undefined) {
            metrics[metricKey] = metricValue;
          }

          if (rowComputedAt) computedAt = rowComputedAt;
          if (rowExpiresAt) expiresAt = rowExpiresAt;
        }

        if (Object.keys(metrics).length > 0) {
          metricsMap.set(pubkey, {
            pubkey,
            metrics,
            computedAt,
            expiresAt,
          });
        }
      }

      return metricsMap;
    } catch (error) {
      throw new DatabaseError(
        `Failed to get metrics batch: ${error instanceof Error ? error.message : String(error)}`,
        "METRICS_GET_BATCH",
      );
    }
  }

  async getPubkeysWithoutScores(candidates: string[]): Promise<string[]> {
    if (!candidates || candidates.length === 0) return [];

    try {
      // Get all pubkeys that have valid scores
      const validPubkeys = await this.getValidPubkeys();

      // Return candidates that are NOT in the valid pubkeys set
      return candidates.filter((p) => !validPubkeys.has(p));
    } catch (error) {
      throw new DatabaseError(
        `Failed to check missing scores: ${error instanceof Error ? error.message : String(error)}`,
        "METRICS_CHECK_MISSING",
      );
    }
  }

  /**
   * Get all pubkeys that currently have valid (non-expired) metrics
   * @returns Set of pubkeys with valid metrics
   */
  private async getValidPubkeys(): Promise<Set<string>> {
    try {
      const now = Math.floor(Date.now() / 1000);

      const result = await this.connection.run(
        `SELECT DISTINCT pubkey
         FROM profile_metrics
         WHERE expires_at > $1`,
        { 1: now },
      );

      const rows = await result.getRows();
      // DuckDB returns columns by index, not by name
      return new Set(rows.map((r) => (r as unknown[])[0] as string));
    } catch (error) {
      throw new DatabaseError(
        `Failed to get valid pubkeys: ${error instanceof Error ? error.message : String(error)}`,
        "METRICS_GET_VALID_PUBKEYS",
      );
    }
  }

  async cleanup(): Promise<number> {
    return executeWithRetry(async () => {
      const now = Math.floor(Date.now() / 1000);
      const result = await this.connection.run(
        "DELETE FROM profile_metrics WHERE expires_at <= $1",
        { 1: now },
      );

      return result.rowCount;
    });
  }

  async getStats(): Promise<{ totalEntries: number }> {
    try {
      const result = await this.connection.run(
        "SELECT COUNT(*) as count FROM profile_metrics",
      );
      const rows = await result.getRows();
      // DuckDB returns columns by index, not by name
      const rowArray = rows[0] as unknown[];
      return { totalEntries: Number(rowArray[0] || 0) };
    } catch {
      return { totalEntries: 0 };
    }
  }
}
