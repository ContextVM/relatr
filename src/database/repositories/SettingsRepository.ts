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

  async getBatch(keys: string[]): Promise<Map<string, string | null>> {
    if (keys.length === 0) {
      return new Map();
    }

    try {
      return await executeWithRetry(async () => {
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(",");
        const params: Record<string, string> = {};
        keys.forEach((key, i) => {
          params[(i + 1).toString()] = key;
        });

        const result = await this.readConnection.run(
          `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
          params,
        );
        const rows = await result.getRows();
        const values = new Map<string, string | null>();

        keys.forEach((key) => values.set(key, null));

        for (const row of rows) {
          const rowArray = row as unknown[];
          values.set(rowArray[0] as string, rowArray[1] as string);
        }

        return values;
      });
    } catch (error) {
      logger.warn(
        `Failed to get settings batch after retries:`,
        error instanceof Error ? error.message : String(error),
      );

      return new Map(keys.map((key) => [key, null]));
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

  async delete(key: string): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          await this.writeConnection.run(
            "DELETE FROM settings WHERE key = $1",
            {
              1: key,
            },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to delete setting ${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to delete setting ${key}: ${error instanceof Error ? error.message : String(error)}`,
        "SETTINGS_DELETE",
      );
    }
  }
}
