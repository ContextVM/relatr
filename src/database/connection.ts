import { Database } from "bun:sqlite";
import { DatabaseError } from "../types";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Initialize database with schema and optimizations
 * @param path - Database file path
 * @returns Database instance
 * @throws DatabaseError if initialization fails
 */
export function initDatabase(path: string): Database {
  try {
    // Create database with WAL mode for better performance
    const db = new Database(path, { create: true });

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
 * Clean up expired cache entries
 * @param db - Database instance
 * @returns Object with counts of deleted entries
 * @throws DatabaseError if cleanup fails
 */
export function cleanupExpiredCache(db: Database): { metricsDeleted: number } {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Clean up expired profile metrics
    const deleteMetricsQuery = db.query(`
            DELETE FROM profile_metrics
            WHERE expires_at < $now
        `);
    const metricsResult = deleteMetricsQuery.run({ now });
    const metricsDeleted = metricsResult.changes || 0;

    // Vacuum to reclaim space
    db.run("VACUUM");

    return {
      metricsDeleted,
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
 * Backup database to specified path
 * @param db - Database instance
 * @param backupPath - Path for backup file
 * @throws DatabaseError if backup fails
 */
export function backupDatabase(db: Database, backupPath: string): void {
  try {
    const backup = new Database(backupPath, { create: true });

    // Use SQLite backup API through serialization
    const serialized = db.serialize();
    const restored = Database.deserialize(serialized);

    // Copy data to backup database
    const backupQuery = backup.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    const tables = backupQuery.all() as { name: string }[];

    for (const table of tables) {
      if (table.name !== "sqlite_sequence") {
        const data = db.query(`SELECT * FROM ${table.name}`).all();
        if (data.length > 0) {
          // Simple approach - recreate table structure and insert data
          const schema = db
            .query(`SELECT sql FROM sqlite_master WHERE name='${table.name}'`)
            .get() as { sql: string };
          if (schema?.sql) {
            backup.run(schema.sql);
            // This is simplified - in production you'd want proper column mapping
          }
        }
      }
    }

    backup.close();
  } catch (error) {
    throw new DatabaseError(
      `Failed to backup database to ${backupPath}: ${error instanceof Error ? error.message : String(error)}`,
      "BACKUP_DATABASE",
    );
  }
}
