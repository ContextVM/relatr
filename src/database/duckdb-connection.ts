import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DatabaseError } from "../types";
import { readFileSync } from "fs";
import { join, resolve } from "path";

let duckDBInstance: DuckDBInstance | null = null;

/**
 * Initialize DuckDB database with schema and optimizations
 * @param path - Database file path
 * @returns DuckDBConnection instance
 * @throws DatabaseError if initialization fails
 */
export async function initDuckDB(path: string): Promise<DuckDBConnection> {
  try {
    // Handle in-memory database case
    const resolvedPath = path === ":memory:" ? path : resolve(path);

    // Create DuckDB instance if it doesn't exist
    if (!duckDBInstance) {
      duckDBInstance = await DuckDBInstance.create(resolvedPath);
    }

    // Create connection
    const connection = await duckDBInstance.connect();

    // Load and execute schema
    const schemaPath = join(__dirname, "duckdb-schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");

    // Execute schema in chunks to avoid statement limits
    const statements = schema.split(";").filter((stmt) => stmt.trim());
    for (const statement of statements) {
      if (statement.trim()) {
        await connection.run(statement);
      }
    }

    return connection;
  } catch (error) {
    throw new DatabaseError(
      `Failed to initialize DuckDB at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "INIT_DATABASE",
    );
  }
}

/**
 * Close DuckDB connection safely
 * @param connection - DuckDBConnection instance to close
 */
export async function closeDuckDB(connection: DuckDBConnection): Promise<void> {
  try {
    connection.closeSync();
  } catch (error) {
    console.error("Error closing DuckDB connection:", error);
  }
}

/**
 * Clean up expired cache entries from all cache tables
 * @param connection - DuckDBConnection instance
 * @returns Object with counts of deleted entries
 * @throws DatabaseError if cleanup fails
 */
export async function cleanupExpiredDuckDBCache(
  connection: DuckDBConnection,
): Promise<{
  metricsDeleted: number;
  metadataDeleted: number;
  totalDeleted: number;
}> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Clean up expired profile metrics
    const metricsResult = await connection.run(
      "DELETE FROM profile_metrics WHERE expires_at < $1",
      { 1: now },
    );
    // DuckDB result doesn't always return rowsChanged for DELETE
    const metricsDeleted = 0;

    // FTS tables don't have expires_at, so skip cleanup for pubkey_metadata
    const metadataDeleted = 0;

    const totalDeleted = metricsDeleted + metadataDeleted;

    // Only checkpoint if significant deletions occurred
    if (totalDeleted > 100) {
      await connection.run("CHECKPOINT FORCE");
    }

    return {
      metricsDeleted,
      metadataDeleted,
      totalDeleted,
    };
  } catch (error) {
    throw new DatabaseError(
      `Failed to cleanup expired cache: ${error instanceof Error ? error.message : String(error)}`,
      "CLEANUP_CACHE",
    );
  }
}

/**
 * Get database statistics
 * @param connection - DuckDBConnection instance
 * @returns Object with database statistics
 * @throws DatabaseError if stats retrieval fails
 */
export async function getDuckDBStats(connection: DuckDBConnection): Promise<{
  profileMetricsCount: number;
  expiredMetricsCount: number;
}> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Count profile metrics
    const metricsCountResult = await connection.run(
      "SELECT COUNT(*) as count FROM profile_metrics",
    );
    const metricsCountRows = await metricsCountResult.getRows();
    const metricsCount = Number((metricsCountRows[0] as any)?.count || 0);

    // Count expired profile metrics
    const expiredMetricsResult = await connection.run(
      `
      SELECT COUNT(*) as count FROM profile_metrics
      WHERE expires_at < $1
    `,
      { 1: now },
    );
    const expiredMetricsRows = await expiredMetricsResult.getRows();
    const expiredMetricsCount = Number(
      (expiredMetricsRows[0] as any)?.count || 0,
    );

    return {
      profileMetricsCount: metricsCount,
      expiredMetricsCount: expiredMetricsCount,
    };
  } catch (error) {
    throw new DatabaseError(
      `Failed to get database stats: ${error instanceof Error ? error.message : String(error)}`,
      "GET_STATS",
    );
  }
}
