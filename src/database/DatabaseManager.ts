import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DatabaseError } from "../types";
import { readFileSync } from "fs";
import { join, resolve } from "path";

/**
 * Manages the DuckDB database instance and connection.
 * Handles initialization, schema loading, and graceful shutdown.
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private duckDB: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
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
      console.warn(
        `[DatabaseManager] Warning: Requested DB path ${dbPath} differs from initialized path ${DatabaseManager.instance.dbPath}. Ignoring new path.`,
      );
    }
    return DatabaseManager.instance;
  }

  /**
   * Initialize the database connection and schema
   */
  public async initialize(): Promise<void> {
    if (this.duckDB) return;

    try {
      const resolvedPath =
        this.dbPath === ":memory:" ? this.dbPath : resolve(this.dbPath);

      // Create instance
      this.duckDB = await DuckDBInstance.create(resolvedPath);

      // Create primary connection
      this.connection = await this.duckDB.connect();

      // Load schema
      await this.loadSchema();

      console.log(`[DatabaseManager] Initialized DuckDB at ${this.dbPath}`);
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
    if (!this.connection)
      throw new DatabaseError("Database not connected", "SCHEMA_LOAD");

    try {
      const schemaPath = join(__dirname, "duckdb-schema.sql");
      const schema = readFileSync(schemaPath, "utf-8");

      // Execute schema in chunks
      const statements = schema.split(";").filter((stmt) => stmt.trim());
      for (const statement of statements) {
        if (statement.trim()) {
          try {
            await this.connection.run(statement);
          } catch (error) {
            throw error;
          }
        }
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to load schema: ${error instanceof Error ? error.message : String(error)}`,
        "SCHEMA_LOAD",
      );
    }
  }

  /**
   * Get the shared DuckDB connection
   */
  public getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new DatabaseError("Database not initialized", "GET_CONNECTION");
    }
    return this.connection;
  }
  /**
   * Close the database connection and all tracked connections
   */
  public async close(): Promise<void> {
    try {
      this.connection?.closeSync();
      this.connection = null;
      this.duckDB = null;
      console.log("[DatabaseManager] Database connections closed");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}
