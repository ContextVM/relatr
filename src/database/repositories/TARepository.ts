import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type TA } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";
import { dbWriteQueue } from "../DbWriteQueue";

export class TARepository {
  private readConnection: DuckDBConnection;
  private writeConnection: DuckDBConnection;

  /**
   * NOTE: DuckDB returns rows by index; keep SELECT projections explicit and in sync with mapRowToTA.
   */
  private static readonly TA_SELECT_COLUMNS =
    "id, pubkey, latest_rank, created_at, computed_at, is_active";

  constructor(
    readConnection: DuckDBConnection,
    writeConnection: DuckDBConnection,
  ) {
    this.readConnection = readConnection;
    this.writeConnection = writeConnection;
  }

  /**
   * Add a new TA
   * @param pubkey Hex-encoded public key of user
   * @returns The created TA record
   * @throws DatabaseError if insertion fails
   */
  async addTA(pubkey: string): Promise<TA> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          const now = Math.floor(Date.now() / 1000);

          await this.writeConnection.run(
            `INSERT INTO ta (pubkey, created_at, computed_at, is_active)
             VALUES ($1, $2, $3, TRUE)
             ON CONFLICT (pubkey) DO UPDATE SET
               is_active = TRUE`,
            { 1: pubkey, 2: now, 3: now },
          );

          // Retrieve the created/updated record (explicit projection to match mapping)
          const result = await this.readConnection.run(
            `SELECT ${TARepository.TA_SELECT_COLUMNS}
             FROM ta
             WHERE pubkey = $1`,
            { 1: pubkey },
          );

          const rows = await result.getRows();
          if (rows.length === 0) {
            throw new Error("Failed to retrieve created user");
          }

          return this.mapRowToTA(rows[0]);
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to add TA user ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to add TA user: ${error instanceof Error ? error.message : String(error)}`,
        "TA_ADD",
      );
    }
  }

  /**
   * Check if an entry is marked as user-requested (is_active flag).
   * @param pubkey Hex-encoded public key to check
   * @returns True if entry exists and is_active = TRUE
   */
  async isActive(pubkey: string): Promise<boolean> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          "SELECT COUNT(*) as count FROM ta WHERE pubkey = $1 AND is_active = TRUE",
          { 1: pubkey },
        );

        const rows = await result.getRows();
        const rowArray = rows[0] as unknown[];
        return Number(rowArray[0]) > 0;
      });
    } catch (error) {
      logger.warn(
        `Failed to check TA active flag for ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to check TA active flag: ${error instanceof Error ? error.message : String(error)}`,
        "TA_ACTIVE_FLAG_CHECK",
      );
    }
  }

  /**
   * Get stale active TA based on computed_at timestamp
   * @param staleThreshold Unix timestamp threshold
   * @returns Array of stale active user records
   */
  async getStaleActiveTA(staleThreshold: number): Promise<TA[]> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          `SELECT ${TARepository.TA_SELECT_COLUMNS}
           FROM ta
           WHERE is_active = TRUE AND (latest_rank IS NULL OR computed_at < $1)
           ORDER BY computed_at ASC`,
          { 1: staleThreshold },
        );

        const rows = await result.getRows();
        return rows.map((row) => this.mapRowToTA(row));
      });
    } catch (error) {
      logger.warn(
        "Failed to get stale active TA after retries:",
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get stale active TA: ${error instanceof Error ? error.message : String(error)}`,
        "ta_GET_STALE_ACTIVE",
      );
    }
  }

  /**
   * Deactivate a user (soft delete).
   *
   * This method is intentionally idempotent:
   * - If the user does not exist, or is already inactive, it does nothing and succeeds.
   * - If the user is active, it marks it inactive (without touching computed_at).
   *
   * @param pubkey Hex-encoded public key to deactivate
   */
  async disableTA(pubkey: string): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          await this.writeConnection.run(
            "UPDATE ta SET is_active = FALSE WHERE pubkey = $1 AND is_active = TRUE",
            { 1: pubkey },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to deactivate TA user ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to deactivate TA user: ${error instanceof Error ? error.message : String(error)}`,
        "TA_DEACTIVATE",
      );
    }
  }

  /**
   * Get user by pubkey
   * @param pubkey Hex-encoded public key
   * @returns TA record or null
   */
  async getTA(pubkey: string): Promise<TA | null> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          `SELECT ${TARepository.TA_SELECT_COLUMNS}
           FROM ta
           WHERE pubkey = $1`,
          { 1: pubkey },
        );

        const rows = await result.getRows();
        if (rows.length === 0) {
          return null;
        }

        return this.mapRowToTA(rows[0]);
      });
    } catch (error) {
      logger.warn(
        `Failed to get TA user ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get TA user: ${error instanceof Error ? error.message : String(error)}`,
        "TA_GET",
      );
    }
  }

  /**
   * Get or create a user entry
   * @param pubkey Hex-encoded public key
   * @param isActive Whether the entry should be marked as user-requested
   * @returns The user record
   */
  async getOrCreateTA(pubkey: string, isActive: boolean = false): Promise<TA> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          const now = Math.floor(Date.now() / 1000);

          // Try to get existing user
          const existingResult = await this.readConnection.run(
            `SELECT ${TARepository.TA_SELECT_COLUMNS}
             FROM ta
             WHERE pubkey = $1`,
            { 1: pubkey },
          );
          const existingRows = await existingResult.getRows();

          if (existingRows.length > 0) {
            const existing = this.mapRowToTA(existingRows[0]);

            // If caller requested isActive=true and row exists with different state, update it
            if (isActive && !existing.isActive) {
              await this.writeConnection.run(
                "UPDATE ta SET is_active = TRUE WHERE pubkey = $1",
                { 1: pubkey },
              );
              existing.isActive = true;
            }

            return existing;
          }

          // Create new user
          await this.writeConnection.run(
            `INSERT INTO ta (pubkey, created_at, computed_at, is_active)
             VALUES ($1, $2, $3, $4)`,
            { 1: pubkey, 2: now, 3: now, 4: isActive },
          );

          const result = await this.readConnection.run(
            `SELECT ${TARepository.TA_SELECT_COLUMNS}
             FROM ta
             WHERE pubkey = $1`,
            { 1: pubkey },
          );

          const rows = await result.getRows();
          if (rows.length === 0) {
            throw new Error("Failed to retrieve created user");
          }

          return this.mapRowToTA(rows[0]);
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to get or create TA user ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get or create TA user: ${error instanceof Error ? error.message : String(error)}`,
        "TA_GET_OR_CREATE",
      );
    }
  }

  /**
   * Update the latest rank for a user
   * @param pubkey Hex-encoded public key
   * @param rank The computed rank (0-100)
   * @param computedAt Unix timestamp when rank was computed
   * @param opts Optional options to skip existence check for hot paths
   */
  async updateLatestRank(
    pubkey: string,
    rank: number,
    computedAt: number,
    opts?: { existsGuaranteed?: boolean },
  ): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          // Verify existence explicitly; DuckDB UPDATE row counts are not reliable.
          // Skip if caller guarantees existence (hot path optimization).
          if (!opts?.existsGuaranteed) {
            const existsResult = await this.readConnection.run(
              "SELECT 1 FROM ta WHERE pubkey = $1 LIMIT 1",
              { 1: pubkey },
            );
            const existsRows = await existsResult.getRows();
            if (existsRows.length === 0) {
              throw new DatabaseError(
                `TA not found: ${pubkey}`,
                "TA_NOT_FOUND",
              );
            }
          }

          await this.writeConnection.run(
            "UPDATE ta SET latest_rank = $1, computed_at = $2 WHERE pubkey = $3",
            { 1: rank, 2: computedAt, 3: pubkey },
          );
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to update TA rank for ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to update TA rank: ${error instanceof Error ? error.message : String(error)}`,
        "TA_RANK_UPDATE",
      );
    }
  }

  /**
   * Update latest ranks for multiple TA in a single transaction
   * @param updates Array of {pubkey, rank, computedAt} objects
   * @throws DatabaseError if any update fails
   */
  async updateLatestRanksBatch(
    updates: Array<{ pubkey: string; rank: number; computedAt: number }>,
  ): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          if (updates.length === 0) {
            return;
          }

          // Process updates in batches to avoid unbounded SQL statements
          const BATCH_SIZE = 500;
          const totalBatches = Math.ceil(updates.length / BATCH_SIZE);

          for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const start = batchIndex * BATCH_SIZE;
            const end = Math.min(start + BATCH_SIZE, updates.length);
            const batch = updates.slice(start, end);

            // Build VALUES clause for bulk update
            const valuesClause = batch
              .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
              .join(", ");

            // Flatten parameters
            const params: (string | number)[] = [];
            for (const update of batch) {
              params.push(update.pubkey, update.rank, update.computedAt);
            }

            // Use DuckDB's FROM clause for bulk update
            await this.writeConnection.run(
              `UPDATE ta
               SET latest_rank = updates.rank,
                   computed_at = updates.computedAt
               FROM (VALUES ${valuesClause}) AS updates(pubkey, rank, computedAt)
               WHERE ta.pubkey = updates.pubkey`,
              params,
            );

            logger.debug(
              `Updated TA ranks batch ${batchIndex + 1}/${totalBatches} (${batch.length} entries)`,
            );
          }
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to update TA ranks in batch after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to update TA ranks in batch: ${error instanceof Error ? error.message : String(error)}`,
        "TA_RANK_UPDATE_BATCH",
      );
    }
  }

  /**
   * Get statistics about TA entries
   * @returns Object with total and active counts
   */
  async getStats(): Promise<{ total: number; active: number }> {
    try {
      return await executeWithRetry(async () => {
        const totalResult = await this.readConnection.run(
          "SELECT COUNT(*) as count FROM ta",
        );
        const activeResult = await this.readConnection.run(
          "SELECT COUNT(*) as count FROM ta WHERE is_active = TRUE",
        );

        const totalRows = await totalResult.getRows();
        const activeRows = await activeResult.getRows();

        const totalRowArray = totalRows[0] as unknown[];
        const activeRowArray = activeRows[0] as unknown[];

        return {
          total: Number(totalRowArray[0] || 0),
          active: Number(activeRowArray[0] || 0),
        };
      });
    } catch (error) {
      logger.warn(
        "Failed to get TA stats after retries:",
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get TA stats: ${error instanceof Error ? error.message : String(error)}`,
        "TA_STATS_GET",
      );
    }
  }

  /**
   * Map a database row to TA interface
   * @param row Database row from DuckDB
   * @returns TA object
   */
  private mapRowToTA(row: unknown): TA {
    const rowArray = row as unknown[];
    return {
      id: Number(rowArray[0]),
      pubkey: rowArray[1] as string,
      latestRank: rowArray[2] !== null ? Number(rowArray[2]) : null,
      createdAt: Number(rowArray[3]),
      computedAt: Number(rowArray[4]),
      isActive: Boolean(rowArray[5]),
    };
  }
}
