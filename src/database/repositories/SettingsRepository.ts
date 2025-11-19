import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError } from "../../types";

export class SettingsRepository {
  private connection: DuckDBConnection;

  constructor(connection: DuckDBConnection) {
    this.connection = connection;
  }

  async get(key: string): Promise<string | null> {
    try {
      const result = await this.connection.run(
        "SELECT value FROM settings WHERE key = $1",
        { 1: key },
      );
      const rows = await result.getRows();
      return rows.length > 0 ? (rows[0] as any).value : null;
    } catch (error) {
      throw new DatabaseError(
        `Failed to get setting ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "SETTINGS_GET",
      );
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      await this.connection.run(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($1, $2, $3)",
        { 1: key, 2: value, 3: now },
      );
    } catch (error) {
      throw new DatabaseError(
        `Failed to set setting ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "SETTINGS_SET",
      );
    }
  }
}
