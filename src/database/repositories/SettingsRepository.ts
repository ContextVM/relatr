import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";
import { dbWriteQueue } from "../DbWriteQueue";
import { nowSeconds } from "@/utils/utils";

export class SettingsRepository {
  private readConnection: DuckDBConnection;
  private writeConnection: DuckDBConnection;

  constructor(
    readConnection: DuckDBConnection,
    writeConnection: DuckDBConnection,
  ) {
    this.readConnection = readConnection;
    this.writeConnection = writeConnection;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          "SELECT value FROM settings WHERE key = $1",
          { 1: key },
        );
        const rows = await result.getRows();
        if (rows.length === 0) return null;

        // DuckDB returns columns by index, not by name
        const rowArray = rows[0] as unknown[];
        return rowArray[0] as string;
      });
    } catch (error) {
      logger.warn(
        `Failed to get setting ${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          const now = nowSeconds();
          await this.writeConnection.run(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($1, $2, $3)",
            { 1: key, 2: value, 3: now },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to set setting ${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to set setting ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "SETTINGS_SET",
      );
    }
  }
}
