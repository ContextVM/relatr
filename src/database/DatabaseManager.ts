import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DatabaseError } from "../types";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { logger } from "../utils/Logger";

/**
 * Manages the DuckDB database instance and connections.
 * Implements dual-connection architecture for read/write separation.
 * Handles initialization, schema loading, and graceful shutdown.
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private duckDB: DuckDBInstance | null = null;
  private writeConnection: DuckDBConnection | null = null;
  private readConnection: DuckDBConnection | null = null;
  private dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Get the singleton instance of DatabaseManager
   */
  public static getInstance(dbPath: string): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager(dbPath);
    } else if (DatabaseManager.instance.dbPath !== dbPath) {
      logger.warn(
        `Warning: Requested DB path ${dbPath} differs from initialized path ${DatabaseManager.instance.dbPath}. Ignoring new path.`,
      );
    }
    return DatabaseManager.instance;
  }

  /**
   * Initialize the database with dual connections (write and read)
   */
  public async initialize(): Promise<void> {
    if (this.duckDB) return;

    try {
      const resolvedPath =
        this.dbPath === ":memory:" ? this.dbPath : resolve(this.dbPath);

      // Create instance
      this.duckDB = await DuckDBInstance.create(resolvedPath);

      // Create write connection (for all write operations)
      this.writeConnection = await this.duckDB.connect();

      // Create read connection (for read-only operations)
      this.readConnection = await this.duckDB.connect();

      // Load schema on write connection only
      await this.loadSchema();

      logger.info(`Initialized DuckDB at ${this.dbPath} with dual connections`);
    } catch (error) {
      throw new DatabaseError(
        `Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`,
        "INIT_DATABASE",
      );
    }
  }

  /**
   * Load and execute the database schema
   */
  private async loadSchema(): Promise<void> {
    if (!this.writeConnection)
      throw new DatabaseError("Write connection not available", "SCHEMA_LOAD");

    try {
      const schemaPath = join(__dirname, "duckdb-schema.sql");
      const schema = readFileSync(schemaPath, "utf-8");

      // Start transaction for schema load
      await this.writeConnection.run("BEGIN TRANSACTION");

      try {
        // Execute schema in chunks
        const statements = schema.split(";").filter((stmt) => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            await this.writeConnection.run(statement);
          }
        }

        // Commit transaction
        await this.writeConnection.run("COMMIT");
      } catch (error) {
        // Rollback on error
        try {
          await this.writeConnection.run("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            "Failed to rollback schema transaction:",
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
        throw error;
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to load schema: ${error instanceof Error ? error.message : String(error)}`,
        "SCHEMA_LOAD",
      );
    }
  }

  /**
   * Get the write connection (for all write operations)
   * Write operations should still use DbWriteQueue for serialization
   */
  public getWriteConnection(): DuckDBConnection {
    if (!this.writeConnection) {
      throw new DatabaseError(
        "Write connection not initialized",
        "GET_WRITE_CONNECTION",
      );
    }
    return this.writeConnection;
  }

  /**
   * Get the read connection (for read-only operations)
   * Read operations can run concurrently without queueing
   */
  public getReadConnection(): DuckDBConnection {
    if (!this.readConnection) {
      throw new DatabaseError(
        "Read connection not initialized",
        "GET_READ_CONNECTION",
      );
    }
    return this.readConnection;
  }

  /**
   * Close the database connections and instance
   */
  public async close(): Promise<void> {
    try {
      // Checkpoint and close write connection first
      if (this.writeConnection) {
        logger.info("Checkpointing database...");
        await this.writeConnection.run("CHECKPOINT");
        this.writeConnection.closeSync();
        this.writeConnection = null;
      }

      // Close read connection
      if (this.readConnection) {
        this.readConnection.closeSync();
        this.readConnection = null;
      }

      this.duckDB = null;
      logger.info("Database connections closed");
    } catch (error) {
      logger.error("Error closing database:", error);
    }
  }
}
