import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type TASubscriber } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";

export class TARepository {
  private connection: DuckDBConnection;

  /**
   * NOTE: DuckDB returns rows by index; keep SELECT projections explicit and in sync with mapRowToSubscriber.
   */
  private static readonly SUBSCRIBER_SELECT_COLUMNS =
    "id, subscriber_pubkey, latest_rank, created_at, updated_at, is_active";

  constructor(connection: DuckDBConnection) {
    this.connection = connection;
  }

  /**
   * Add a new TA subscriber
   * @param subscriberPubkey Hex-encoded public key of subscriber
   * @returns The created subscriber record
   * @throws DatabaseError if insertion fails
   */
  async addSubscriber(subscriberPubkey: string): Promise<TASubscriber> {
    try {
      return await executeWithRetry(async () => {
        const now = Math.floor(Date.now() / 1000);

        await this.connection.run(
          `INSERT INTO ta_subscribers (subscriber_pubkey, created_at, updated_at, is_active)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (subscriber_pubkey) DO UPDATE SET
             is_active = TRUE,
             updated_at = $3`,
          { 1: subscriberPubkey, 2: now, 3: now },
        );

        // Retrieve the created/updated record (explicit projection to match mapping)
        const result = await this.connection.run(
          `SELECT ${TARepository.SUBSCRIBER_SELECT_COLUMNS}
           FROM ta_subscribers
           WHERE subscriber_pubkey = $1`,
          { 1: subscriberPubkey },
        );

        const rows = await result.getRows();
        if (rows.length === 0) {
          throw new Error("Failed to retrieve created subscriber");
        }

        return this.mapRowToSubscriber(rows[0]);
      });
    } catch (error) {
      logger.warn(
        `Failed to add TA subscriber ${subscriberPubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to add TA subscriber: ${error instanceof Error ? error.message : String(error)}`,
        "TA_SUBSCRIBER_ADD",
      );
    }
  }

  /**
   * Check if a pubkey is subscribed
   * @param subscriberPubkey Hex-encoded public key to check
   * @returns True if subscribed and active
   */
  async isSubscribed(subscriberPubkey: string): Promise<boolean> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.connection.run(
          "SELECT COUNT(*) as count FROM ta_subscribers WHERE subscriber_pubkey = $1 AND is_active = TRUE",
          { 1: subscriberPubkey },
        );

        const rows = await result.getRows();
        const rowArray = rows[0] as unknown[];
        return Number(rowArray[0]) > 0;
      });
    } catch (error) {
      logger.warn(
        `Failed to check TA subscription for ${subscriberPubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to check TA subscription: ${error instanceof Error ? error.message : String(error)}`,
        "TA_SUBSCRIPTION_CHECK",
      );
    }
  }

  /**
   * Get all active subscribers
   * @returns Array of active subscriber pubkeys
   */
  async getActiveSubscribers(): Promise<string[]> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.connection.run(
          "SELECT subscriber_pubkey FROM ta_subscribers WHERE is_active = TRUE",
        );

        const rows = await result.getRows();
        return rows.map((row) => {
          const rowArray = row as unknown[];
          return rowArray[0] as string;
        });
      });
    } catch (error) {
      logger.warn(
        "Failed to get active TA subscribers after retries:",
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get active TA subscribers: ${error instanceof Error ? error.message : String(error)}`,
        "TA_ACTIVE_SUBSCRIBERS_GET",
      );
    }
  }

  /**
   * Deactivate a subscriber (soft delete).
   *
   * This method is intentionally idempotent:
   * - If the subscriber does not exist, or is already inactive, it does nothing and succeeds.
   * - If the subscriber is active, it marks it inactive and updates updated_at.
   *
   * @param subscriberPubkey Hex-encoded public key to deactivate
   */
  async deactivateSubscriber(subscriberPubkey: string): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        const now = Math.floor(Date.now() / 1000);

        await this.connection.run(
          "UPDATE ta_subscribers SET is_active = FALSE, updated_at = $1 WHERE subscriber_pubkey = $2 AND is_active = TRUE",
          { 1: now, 2: subscriberPubkey },
        );
      });
    } catch (error) {
      logger.warn(
        `Failed to deactivate TA subscriber ${subscriberPubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to deactivate TA subscriber: ${error instanceof Error ? error.message : String(error)}`,
        "TA_SUBSCRIBER_DEACTIVATE",
      );
    }
  }

  /**
   * Get subscriber by pubkey
   * @param subscriberPubkey Hex-encoded public key
   * @returns Subscriber record or null
   */
  async getSubscriber(subscriberPubkey: string): Promise<TASubscriber | null> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.connection.run(
          `SELECT ${TARepository.SUBSCRIBER_SELECT_COLUMNS}
           FROM ta_subscribers
           WHERE subscriber_pubkey = $1`,
          { 1: subscriberPubkey },
        );

        const rows = await result.getRows();
        if (rows.length === 0) {
          return null;
        }

        return this.mapRowToSubscriber(rows[0]);
      });
    } catch (error) {
      logger.warn(
        `Failed to get TA subscriber ${subscriberPubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to get TA subscriber: ${error instanceof Error ? error.message : String(error)}`,
        "TA_SUBSCRIBER_GET",
      );
    }
  }

  /**
   * Update the latest rank for a subscriber
   * @param subscriberPubkey Hex-encoded public key
   * @param rank The computed rank (0-100)
   * @param computedAt Unix timestamp when rank was computed
   */
  async updateLatestRank(
    subscriberPubkey: string,
    rank: number,
    computedAt: number,
  ): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        // Verify existence explicitly; DuckDB UPDATE row counts are not reliable.
        const existsResult = await this.connection.run(
          "SELECT 1 FROM ta_subscribers WHERE subscriber_pubkey = $1 LIMIT 1",
          { 1: subscriberPubkey },
        );
        const existsRows = await existsResult.getRows();
        if (existsRows.length === 0) {
          throw new DatabaseError(
            `Subscriber not found: ${subscriberPubkey}`,
            "TA_SUBSCRIBER_NOT_FOUND",
          );
        }

        await this.connection.run(
          "UPDATE ta_subscribers SET latest_rank = $1, updated_at = $2 WHERE subscriber_pubkey = $3",
          { 1: rank, 2: computedAt, 3: subscriberPubkey },
        );
      });
    } catch (error) {
      logger.warn(
        `Failed to update TA rank for ${subscriberPubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to update TA rank: ${error instanceof Error ? error.message : String(error)}`,
        "TA_RANK_UPDATE",
      );
    }
  }

  /**
   * Get statistics about TA subscriptions
   * @returns Object with total and active counts
   */
  async getStats(): Promise<{ total: number; active: number }> {
    try {
      return await executeWithRetry(async () => {
        const totalResult = await this.connection.run(
          "SELECT COUNT(*) as count FROM ta_subscribers",
        );
        const activeResult = await this.connection.run(
          "SELECT COUNT(*) as count FROM ta_subscribers WHERE is_active = TRUE",
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
   * Map a database row to TASubscriber interface
   * @param row Database row from DuckDB
   * @returns TASubscriber object
   */
  private mapRowToSubscriber(row: unknown): TASubscriber {
    const rowArray = row as unknown[];
    return {
      id: Number(rowArray[0]),
      subscriberPubkey: rowArray[1] as string,
      latestRank: rowArray[2] !== null ? Number(rowArray[2]) : null,
      createdAt: Number(rowArray[3]),
      updatedAt: Number(rowArray[4]),
      isActive: Boolean(rowArray[5]),
    };
  }
}
