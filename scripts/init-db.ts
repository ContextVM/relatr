#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { config } from "../src/config/environment";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

/**
 * Initialize the SQLite database with the schema
 */
function initializeDatabase(dbPath: string): Database {
  console.log(`Initializing database at: ${dbPath}`);

  try {
    // Create database with WAL mode for better performance
    const db = new Database(dbPath, { create: true });

    // Enable foreign keys and optimize performance
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA cache_size = 10000;");
    db.exec("PRAGMA temp_store = memory;");

    console.log("Database created successfully");
    return db;
  } catch (error) {
    console.error("Failed to create database:", error);
    throw error;
  }
}

/**
 * Load and execute the schema SQL file
 */
function loadSchema(db: Database, schemaPath: string): void {
  console.log(`Loading schema from: ${schemaPath}`);

  try {
    const schema = readFileSync(schemaPath, "utf-8");

    // Execute schema directly (no transaction needed for schema creation)
    db.exec(schema);

    console.log("Schema loaded successfully");
  } catch (error) {
    console.error("Failed to load schema:", error);
    throw error;
  }
}

/**
 * Verify that all expected tables exist
 */
function verifySchema(db: Database): boolean {
  console.log("Verifying database schema...");

  const expectedTables = [
    "pubkeys",
    "metric_definitions",
    "profile_metrics",
    "trust_scores",
    "configuration",
    "nostr_events_cache",
  ];

  try {
    const result = db
      .query(
        `
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
        `,
      )
      .all() as { name: string }[];

    const actualTables = result.map((row) => row.name);

    console.log("Found tables:", actualTables);

    // Check if all expected tables exist
    const missingTables = expectedTables.filter(
      (table) => !actualTables.includes(table),
    );

    if (missingTables.length > 0) {
      console.error("Missing tables:", missingTables);
      return false;
    }

    // Verify metric definitions were inserted
    const metricCount = db
      .query("SELECT COUNT(*) as count FROM metric_definitions")
      .get() as { count: number };
    console.log(`Metric definitions: ${metricCount.count}`);

    // Verify configuration was inserted
    const configCount = db
      .query("SELECT COUNT(*) as count FROM configuration")
      .get() as { count: number };
    console.log(`Configuration entries: ${configCount.count}`);

    console.log("Schema verification passed");
    return true;
  } catch (error) {
    console.error("Schema verification failed:", error);
    return false;
  }
}

/**
 * Test basic database operations
 */
function testDatabaseOperations(db: Database): boolean {
  console.log("Testing basic database operations...");

  try {
    // Test pubkey insertion
    const now = Math.floor(Date.now() / 1000);
    const insertResult = db
      .query(
        `
            INSERT INTO pubkeys (pubkey, first_seen_at, last_updated_at)
            VALUES ($pubkey, $first_seen_at, $last_updated_at)
            RETURNING id
        `,
      )
      .get({
        $pubkey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        $first_seen_at: now,
        $last_updated_at: now,
      }) as { id: number };

    console.log(`Inserted pubkey with ID: ${insertResult.id}`);

    // Test querying metrics
    const metrics = db
      .query(
        `
            SELECT md.metric_name, md.metric_type, md.default_weight
            FROM metric_definitions md
            WHERE md.is_active = 1
        `,
      )
      .all();

    console.log(
      `Found ${metrics.length} active metrics:`,
      metrics.map((m) => (m as any).metric_name),
    );

    // Test configuration retrieval
    const config = db
      .query(
        `
            SELECT config_key, config_value, value_type
            FROM configuration
            WHERE config_key = 'distance_decay_factor'
        `,
      )
      .get();

    console.log("Retrieved configuration:", config);

    // Clean up test data
    db.query("DELETE FROM pubkeys WHERE pubkey = $pubkey").run({
      $pubkey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    console.log("Basic operations test passed");
    return true;
  } catch (error) {
    console.error("Basic operations test failed:", error);
    return false;
  }
}

/**
 * Main initialization function
 */
async function main(): Promise<void> {
  console.log("🚀 Initializing Relatr Database");
  console.log("===============================");

  try {
    // Ensure data directory exists
    const dataDir = dirname(config.DB_PATH);
    await Bun.write(`${dataDir}/.keep`, "");

    // Initialize database
    const db = initializeDatabase(config.DB_PATH);

    // Load schema
    const schemaPath = join(projectRoot, "src/database/schema.sql");
    loadSchema(db, schemaPath);

    // Verify schema
    if (!verifySchema(db)) {
      throw new Error("Schema verification failed");
    }

    // Test basic operations
    if (!testDatabaseOperations(db)) {
      throw new Error("Basic operations test failed");
    }

    // Close database connection
    db.close();

    console.log("===============================");
    console.log("✅ Database initialization completed successfully!");
    console.log(`📍 Database location: ${config.DB_PATH}`);
    console.log("");
    console.log("To verify tables exist, run:");
    console.log(`sqlite3 ${config.DB_PATH} ".tables"`);
  } catch (error) {
    console.error("===============================");
    console.error("❌ Database initialization failed:");
    console.error(error);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (import.meta.main) {
  main();
}
