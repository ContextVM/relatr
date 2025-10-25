import { Database } from "bun:sqlite";
import { DatabaseError } from "../types";
import { readFileSync, statSync } from "fs";
import { join, dirname, resolve } from "path";

/**
 * Initialize database with schema and optimizations
 * @param path - Database file path
 * @returns Database instance
 * @throws DatabaseError if initialization fails
 */
export function initDatabase(path: string): Database {
  try {
    const resolvedPath = resolve(path);
    const dirPath = dirname(resolvedPath);
    const effectiveUid =
      typeof process.getuid === "function" ? process.getuid() : null;
    const effectiveGid =
      typeof process.getgid === "function" ? process.getgid() : null;

    console.debug(
      `[Database] Requested SQLite path ${
        path !== resolvedPath ? `${path} -> ${resolvedPath}` : resolvedPath
      } (cwd: ${process.cwd()})`,
    );
    console.debug(
      `[Database] Effective runtime identity uid=${String(
        effectiveUid ?? "unknown",
      )} gid=${String(effectiveGid ?? "unknown")}`,
    );

    try {
      const dirStats = statSync(dirPath);
      const mode = dirStats.mode & 0o777;
      const writableByCaller = Boolean(
        (effectiveUid !== null &&
          dirStats.uid === effectiveUid &&
          mode & 0o200) ||
          (effectiveGid !== null &&
            dirStats.gid === effectiveGid &&
            mode & 0o020) ||
          mode & 0o002,
      );

      console.debug(
        `[Database] Directory ${dirPath} owner=${dirStats.uid}:${dirStats.gid} mode=${mode.toString(
          8,
        )} writableByCaller=${writableByCaller}`,
      );
    } catch (statError) {
      console.warn(
        `[Database] Unable to stat parent directory ${dirPath}: ${
          statError instanceof Error ? statError.message : String(statError)
        }`,
      );
    }

    // Create database with WAL mode for better performance
    const db = new Database(resolvedPath, { create: true });

    // Enable SQLite optimizations
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = 10000");
    db.run("PRAGMA temp_store = memory");

    // Load and execute schema
    const schemaPath = join(__dirname, "schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");
    db.run(schema);

    return db;
  } catch (error) {
    throw new DatabaseError(
      `Failed to initialize database at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "INIT_DATABASE",
    );
  }
}

/**
 * Close database connection safely
 * @param db - Database instance to close
 */
export function closeDatabase(db: Database): void {
  try {
    if (db) {
      db.close(false); // Allow existing queries to finish
    }
  } catch (error) {
    // Log error but don't throw - closing is cleanup operation
    console.error("Error closing database:", error);
  }
}

/**
 * Clean up expired cache entries from all cache tables
 * @param db - Database instance
 * @returns Object with counts of deleted entries
 * @throws DatabaseError if cleanup fails
 */
export function cleanupExpiredCache(db: Database): {
  metricsDeleted: number;
  metadataDeleted: number;
  totalDeleted: number;
} {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Clean up all cache tables in one transaction
    db.run("BEGIN TRANSACTION");

    // Clean up expired profile metrics
    const metricsResult = db
      .query("DELETE FROM profile_metrics WHERE expires_at < ?")
      .run(now);
    const metricsDeleted = metricsResult.changes || 0;

    // FTS5 tables don't have expires_at, so skip cleanup for pubkey_metadata
    const metadataDeleted = 0;

    db.run("COMMIT");

    const totalDeleted = metricsDeleted + metadataDeleted;

    // Only vacuum if significant deletions occurred
    if (totalDeleted > 100) {
      db.run("VACUUM");
    }

    return {
      metricsDeleted,
      metadataDeleted,
      totalDeleted,
    };
  } catch (error) {
    db.run("ROLLBACK");
    throw new DatabaseError(
      `Failed to cleanup expired cache: ${error instanceof Error ? error.message : String(error)}`,
      "CLEANUP_CACHE",
    );
  }
}

/**
 * Get database statistics
 * @param db - Database instance
 * @returns Object with database statistics
 * @throws DatabaseError if stats retrieval fails
 */
export function getDatabaseStats(db: Database): {
  profileMetricsCount: number;
  expiredMetricsCount: number;
} {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Count profile metrics
    const metricsCountQuery = db.query(
      "SELECT COUNT(*) as count FROM profile_metrics",
    );
    const metricsCountResult = metricsCountQuery.get() as { count: number };

    // Count expired profile metrics
    const expiredMetricsQuery = db.query(`
            SELECT COUNT(*) as count FROM profile_metrics
            WHERE expires_at < $now
        `);
    const expiredMetricsResult = expiredMetricsQuery.get({ now }) as {
      count: number;
    };

    return {
      profileMetricsCount: metricsCountResult.count,
      expiredMetricsCount: expiredMetricsResult.count,
    };
  } catch (error) {
    throw new DatabaseError(
      `Failed to get database stats: ${error instanceof Error ? error.message : String(error)}`,
      "GET_STATS",
    );
  }
}

/**
 * Check if database is healthy and accessible
 * @param db - Database instance
 * @returns true if database is healthy, false otherwise
 */
export function isDatabaseHealthy(db: Database): boolean {
  try {
    // Simple query to test database connectivity
    const testQuery = db.query("SELECT 1 as test");
    testQuery.get();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Backup database to specified path using SQLite's serialization
 * @param db - Database instance
 * @param backupPath - Path for backup file
 * @throws DatabaseError if backup fails
 */
export function backupDatabase(db: Database, backupPath: string): void {
  try {
    // Serialize the current database
    const serialized = db.serialize();

    // Write serialized data to file
    Bun.write(backupPath, serialized);
  } catch (error) {
    throw new DatabaseError(
      `Failed to backup database to ${backupPath}: ${error instanceof Error ? error.message : String(error)}`,
      "BACKUP_DATABASE",
    );
  }
}
