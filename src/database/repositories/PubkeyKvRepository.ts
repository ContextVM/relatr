import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";
import { dbWriteQueue } from "../DbWriteQueue";
import type { PubkeyKvKey } from "../../constants/pubkeyKv";
import { nowSeconds } from "@/utils/utils";

/**
 * Repository for the pubkey_kv key-value store.
 *
 * Provides a generic, extensible storage mechanism for associating
 * arbitrary metadata with Nostr pubkeys.
 */
export class PubkeyKvRepository {
  private readConnection: DuckDBConnection;
  private writeConnection: DuckDBConnection;

  constructor(
    readConnection: DuckDBConnection,
    writeConnection: DuckDBConnection,
  ) {
    this.readConnection = readConnection;
    this.writeConnection = writeConnection;
  }

  /**
   * Get a value from the key-value store.
   * @param pubkey The public key
   * @param key The key to retrieve
   * @returns The value as a string, or null if not found
   */
  async get(pubkey: string, key: PubkeyKvKey): Promise<string | null> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          "SELECT value FROM pubkey_kv WHERE pubkey = $1 AND key = $2",
          { 1: pubkey, 2: key },
        );

        const rows = await result.getRows();
        if (rows.length === 0) {
          return null;
        }

        const rowArray = rows[0] as unknown[];
        return rowArray[0] as string;
      });
    } catch (error) {
      logger.warn(
        `Failed to get pubkey_kv for ${pubkey}:${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Set a value in the key-value store.
   * Uses UPSERT semantics: on conflict, updates value and updated_at while preserving created_at.
   * @param pubkey The public key
   * @param key The key to set
   * @param value The value to store
   */
  async set(pubkey: string, key: PubkeyKvKey, value: string): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          const now = nowSeconds();

          // Use INSERT ... ON CONFLICT DO UPDATE for UPSERT behavior
          await this.writeConnection.run(
            `INSERT INTO pubkey_kv (pubkey, key, value, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (pubkey, key) DO UPDATE SET
               value = EXCLUDED.value,
               updated_at = EXCLUDED.updated_at`,
            { 1: pubkey, 2: key, 3: value, 4: now },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to set pubkey_kv for ${pubkey}:${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to set pubkey_kv for ${pubkey}:${key}: ${error instanceof Error ? error.message : String(error)}`,
        "PUBKEY_KV_SET",
      );
    }
  }

  /**
   * Get every stored value for a key, by pubkey.
   * @param key The key to read
   * @returns Map of pubkey to value
   */
  async getAllForKey(key: PubkeyKvKey): Promise<Map<string, string>> {
    return await executeWithRetry(async () => {
      const result = await this.readConnection.run(
        "SELECT pubkey, value FROM pubkey_kv WHERE key = $1",
        { 1: key },
      );
      const rows = (await result.getRows()) as [string, string][];
      return new Map(rows);
    });
  }

  /**
   * Set one key for many pubkeys in a single transaction, with the same UPSERT semantics as `set`.
   * @param key The key to set
   * @param values Map of pubkey to value
   */
  async setMany(key: PubkeyKvKey, values: Map<string, string>): Promise<void> {
    if (values.size === 0) {
      return;
    }

    const entries = Array.from(values);
    // Keeps each statement well below DuckDB's prepared-parameter limits.
    const rowsPerStatement = 1000;

    try {
      await executeWithRetry(async () => {
        await dbWriteQueue.runExclusive(async () => {
          const now = nowSeconds();
          await this.writeConnection.run("BEGIN TRANSACTION");
          try {
            for (let i = 0; i < entries.length; i += rowsPerStatement) {
              const chunk = entries.slice(i, i + rowsPerStatement);
              const params: Record<number, string | number> = { 1: key, 2: now };
              const valuesClause = chunk
                .map(([pubkey, value], j) => {
                  params[3 + j * 2] = pubkey;
                  params[4 + j * 2] = value;
                  return `($${3 + j * 2}, $1, $${4 + j * 2}, $2, $2)`;
                })
                .join(", ");

              await this.writeConnection.run(
                `INSERT INTO pubkey_kv (pubkey, key, value, created_at, updated_at)
                 VALUES ${valuesClause}
                 ON CONFLICT (pubkey, key) DO UPDATE SET
                   value = EXCLUDED.value,
                   updated_at = EXCLUDED.updated_at`,
                params,
              );
            }
            await this.writeConnection.run("COMMIT");
          } catch (error) {
            await this.writeConnection.run("ROLLBACK");
            throw error;
          }
        });
      });
    } catch (error) {
      throw new DatabaseError(
        `Failed to set pubkey_kv ${key} for ${values.size} pubkeys: ${error instanceof Error ? error.message : String(error)}`,
        "PUBKEY_KV_SET_MANY",
      );
    }
  }

  /**
   * Get a JSON value from the key-value store and parse it.
   * @param pubkey The public key
   * @param key The key to retrieve
   * @returns The parsed value, or null if not found or parsing fails
   */
  async getJSON<T>(pubkey: string, key: PubkeyKvKey): Promise<T | null> {
    const value = await this.get(pubkey, key);
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as T;
    } catch (parseError) {
      logger.warn(
        `Failed to parse JSON for pubkey_kv ${pubkey}:${key}:`,
        parseError instanceof Error ? parseError.message : String(parseError),
      );
      return null;
    }
  }

  /**
   * Set a JSON value in the key-value store.
   * The value will be JSON stringified before storage.
   * @param pubkey The public key
   * @param key The key to set
   * @param value The value to store (will be JSON stringified)
   */
  async setJSON(
    pubkey: string,
    key: PubkeyKvKey,
    value: unknown,
  ): Promise<void> {
    const jsonValue = JSON.stringify(value);
    await this.set(pubkey, key, jsonValue);
  }

  /**
   * Delete a value from the key-value store.
   * @param pubkey The public key
   * @param key The key to delete
   */
  async delete(pubkey: string, key: PubkeyKvKey): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          await this.writeConnection.run(
            "DELETE FROM pubkey_kv WHERE pubkey = $1 AND key = $2",
            { 1: pubkey, 2: key },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to delete pubkey_kv for ${pubkey}:${key} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to delete pubkey_kv for ${pubkey}:${key}: ${error instanceof Error ? error.message : String(error)}`,
        "PUBKEY_KV_DELETE",
      );
    }
  }
}
