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
  private connections: Set<DuckDBConnection> = new Set();
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
      this.connections.add(this.connection);

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
            // Handle FTS index already exists error specifically
            if (
              statement.includes("PRAGMA create_fts_index") &&
              error instanceof Error &&
              error.message.includes("a FTS index already exists")
            ) {
              console.warn(
                "[DatabaseManager] FTS index already exists, skipping creation.",
              );
              continue;
            }
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
   * Get the active DuckDB connection (primary connection)
   */
  public getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new DatabaseError("Database not initialized", "GET_CONNECTION");
    }
    return this.connection;
  }

  /**
   * Create a new DuckDB connection
   * Returns a fresh connection that is tracked for cleanup
   */
  public async createConnection(): Promise<DuckDBConnection> {
    if (!this.duckDB) {
      throw new DatabaseError("Database not initialized", "CREATE_CONNECTION");
    }
    const conn = await this.duckDB.connect();
    this.connections.add(conn);
    return conn;
  }

  /**
   * Close the database connection and all tracked connections
   */
  public async close(): Promise<void> {
    try {
      // Close all tracked connections
      for (const conn of this.connections) {
        try {
          conn.closeSync();
        } catch (e) {
          console.warn("Error closing connection:", e);
        }
      }
      this.connections.clear();
      this.connection = null;
      this.duckDB = null;
      console.log("[DatabaseManager] Database connections closed");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}
