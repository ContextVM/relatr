import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type NostrProfile } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";
import { dbWriteQueue } from "../DbWriteQueue";
import { nowSeconds } from "@/utils/utils";

export interface SearchResult {
  pubkey: string;
  score: number;
  rank: number;
  isExactMatch: boolean;
}

const SEARCH_TEXT_SCORES = {
  nameExact: 1.4,
  displayNameExact: 1.3,
  nip05Exact: 1.2,
  lud16Exact: 1.0,
  namePrefix: 1.1,
  displayNamePrefix: 1.05,
  nip05Prefix: 1.0,
  lud16Prefix: 0.85,
  nameContains: 0.9,
  displayNameContains: 0.8,
  nip05Contains: 0.7,
  lud16Contains: 0.6,
  aboutContains: 0.35,
} as const;

const SEARCH_DISTANCE_WEIGHT = 0.6;
const SEARCH_VALIDATION_WEIGHT = 0.4;

export class MetadataRepository {
  constructor(
    private readConnection: DuckDBConnection,
    private writeConnection: DuckDBConnection,
    private ttlSeconds: number = 60 * 60 * 48,
  ) {}

  async save(profile: NostrProfile): Promise<void> {
    await this.saveMany([profile]);
  }

  async saveMany(profiles: NostrProfile[]): Promise<void> {
    if (profiles.length === 0) return;

    try {
      return await executeWithRetry(async () => {
        return await dbWriteQueue.runExclusive(async () => {
          const now = nowSeconds();

          // Start transaction
          await this.writeConnection.run("BEGIN TRANSACTION");

          try {
            // Extract pubkeys for deletion
            const pubkeys = profiles.map((p) => p.pubkey);

            // Delete existing records in batch
            if (pubkeys.length > 0) {
              const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(",");
              await this.writeConnection.run(
                `DELETE FROM pubkey_metadata WHERE pubkey IN (${placeholders})`,
                Object.fromEntries(pubkeys.map((pk, i) => [i + 1, pk])),
              );
            }

            // Insert new records in batch using VALUES clause
            const valuesClause = profiles
              .map(
                (_, i) =>
                  `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`,
              )
              .join(", ");

            const insertQuery = `
              INSERT INTO pubkey_metadata (pubkey, name, display_name, nip05, lud16, about, created_at)
              VALUES ${valuesClause}
            `;

            // Build parameters object with proper type handling
            const params: Record<string, string | null | number> = {};
            profiles.forEach((profile, i) => {
              const baseIndex = i * 7;
              params[baseIndex + 1] = profile.pubkey;
              params[baseIndex + 2] = profile.name || null;
              params[baseIndex + 3] = profile.display_name || null;
              params[baseIndex + 4] = profile.nip05 || null;
              params[baseIndex + 5] = profile.lud16 || null;
              params[baseIndex + 6] = profile.about || null;
              params[baseIndex + 7] = now;
            });

            await this.writeConnection.run(insertQuery, params);

            // Commit transaction
            await this.writeConnection.run("COMMIT");
          } catch (error) {
            // Rollback on error
            try {
              await this.writeConnection.run("ROLLBACK");
            } catch (rollbackError) {
              logger.error(
                "Failed to rollback metadata transaction:",
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
              );
            }
            throw error;
          }
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to save metadata for ${profiles.length} profiles after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to save metadata for ${profiles.length} profiles: ${error instanceof Error ? error.message : String(error)}`,
        "METADATA_SAVE",
      );
    }
  }

  async get(pubkey: string): Promise<NostrProfile | null> {
    try {
      return await executeWithRetry(async () => {
        const staleThreshold = nowSeconds() - this.ttlSeconds;
        const result = await this.readConnection.run(
          `SELECT pubkey, name, display_name, nip05, lud16, about
           FROM pubkey_metadata
           WHERE pubkey = $1
             AND created_at > $2`,
          { 1: pubkey, 2: staleThreshold },
        );

        const rows = await result.getRows();
        if (rows.length === 0) return null;

        const row = rows[0] as unknown[];
        return {
          pubkey: row[0] as string,
          name: (row[1] as string | null) || undefined,
          display_name: (row[2] as string | null) || undefined,
          nip05: (row[3] as string | null) || undefined,
          lud16: (row[4] as string | null) || undefined,
          about: (row[5] as string | null) || undefined,
        };
      });
    } catch (error) {
      logger.warn(
        `Failed to get metadata for ${pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Get metadata for multiple pubkeys in a single batch query
   * @param pubkeys - Array of public keys to retrieve metadata for
   * @returns Map of pubkey to NostrProfile (null if not found)
   */
  async getBatch(pubkeys: string[]): Promise<Map<string, NostrProfile | null>> {
    if (!pubkeys || pubkeys.length === 0) {
      return new Map();
    }

    try {
      return await executeWithRetry(async () => {
        const staleThreshold = nowSeconds() - this.ttlSeconds;
        // Create placeholders for IN clause
        const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(",");
        const params: Record<string, string | number> = {};
        pubkeys.forEach((pubkey, i) => {
          params[(i + 1).toString()] = pubkey;
        });
        params[(pubkeys.length + 1).toString()] = staleThreshold;

        const result = await this.readConnection.run(
          `SELECT pubkey, name, display_name, nip05, lud16, about
           FROM pubkey_metadata
           WHERE pubkey IN (${placeholders})
             AND created_at > $${pubkeys.length + 1}`,
          params,
        );

        const rows = await result.getRows();
        const profilesMap = new Map<string, NostrProfile | null>();

        // Initialize all pubkeys with null (not found)
        pubkeys.forEach((pubkey) => profilesMap.set(pubkey, null));

        // Build profiles for found pubkeys
        for (const row of rows) {
          const rowArray = row as unknown[];
          const pubkey = rowArray[0] as string;
          const profile: NostrProfile = {
            pubkey,
            name: (rowArray[1] as string | null) || undefined,
            display_name: (rowArray[2] as string | null) || undefined,
            nip05: (rowArray[3] as string | null) || undefined,
            lud16: (rowArray[4] as string | null) || undefined,
            about: (rowArray[5] as string | null) || undefined,
          };
          profilesMap.set(pubkey, profile);
        }

        return profilesMap;
      });
    } catch (error) {
      logger.warn(
        `Failed to get metadata batch after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      // Return fallback map with all pubkeys as null
      const fallbackMap = new Map<string, NostrProfile | null>();
      pubkeys.forEach((pubkey) => fallbackMap.set(pubkey, null));
      return fallbackMap;
    }
  }

  /**
   * Optimized pattern-based search with distance-aware ranking
   * Uses DuckDB window functions and LIMIT to efficiently return only top candidates
   * This dramatically reduces the number of profiles requiring trust calculation
   */
  async search(
    query: string,
    limit: number = 20,
    decayFactor: number = 0.5,
  ): Promise<SearchResult[]> {
    try {
      return await executeWithRetry(async () => {
        const staleThreshold = nowSeconds() - this.ttlSeconds;
        // Calculate candidate limit: return enough candidates for trust calculation
        // but not so many that we process thousands of profiles
        const candidateLimit = Math.max(limit * 20, 100);

        const textScoreCase = `
          CASE
            WHEN LOWER(m.name) = LOWER($1) THEN ${SEARCH_TEXT_SCORES.nameExact}
            WHEN LOWER(m.display_name) = LOWER($1) THEN ${SEARCH_TEXT_SCORES.displayNameExact}
            WHEN LOWER(m.nip05) = LOWER($1) THEN ${SEARCH_TEXT_SCORES.nip05Exact}
            WHEN LOWER(m.lud16) = LOWER($1) THEN ${SEARCH_TEXT_SCORES.lud16Exact}
            WHEN m.name ILIKE $1 || '%' THEN ${SEARCH_TEXT_SCORES.namePrefix}
            WHEN m.display_name ILIKE $1 || '%' THEN ${SEARCH_TEXT_SCORES.displayNamePrefix}
            WHEN m.nip05 ILIKE $1 || '%' THEN ${SEARCH_TEXT_SCORES.nip05Prefix}
            WHEN m.lud16 ILIKE $1 || '%' THEN ${SEARCH_TEXT_SCORES.lud16Prefix}
            WHEN m.name ILIKE '%' || $1 || '%' THEN ${SEARCH_TEXT_SCORES.nameContains}
            WHEN m.display_name ILIKE '%' || $1 || '%' THEN ${SEARCH_TEXT_SCORES.displayNameContains}
            WHEN m.nip05 ILIKE '%' || $1 || '%' THEN ${SEARCH_TEXT_SCORES.nip05Contains}
            WHEN m.lud16 ILIKE '%' || $1 || '%' THEN ${SEARCH_TEXT_SCORES.lud16Contains}
            WHEN m.about ILIKE '%' || $1 || '%' THEN ${SEARCH_TEXT_SCORES.aboutContains}
            ELSE 0.0
          END
        `;

        const distanceScoreCase = `
          CASE
            WHEN d.distance <= 1 THEN 1.0
            WHEN d.distance = 1000 THEN 0.0
            ELSE exp(-$3 * d.distance)
          END
        `;

        const result = await this.readConnection.run(
          `
        WITH ranked_matches AS (
          SELECT
            m.pubkey,
            m.name,
            m.display_name,
            m.nip05,
            -- Text relevance scoring with priority for exact and prefix matches
            ${textScoreCase} AS text_score,
            -- Exact match flag
            CASE
              WHEN LOWER(m.name) = LOWER($1)
                OR LOWER(m.display_name) = LOWER($1)
                OR LOWER(m.nip05) = LOWER($1)
                OR LOWER(m.lud16) = LOWER($1) THEN true
              ELSE false
            END AS is_exact_match,
            -- Social distance score (exponential decay matching TrustCalculator)
            ${distanceScoreCase} AS distance_score,
            d.distance,
            -- Validation score (average of all metrics for this pubkey)
            COALESCE(v.avg_validation, 0.5) AS validation_score,
            v.validation_count,
            -- Pre-rank score: combines distance, validation, and text relevance
            -- Formula favors graph proximity slightly more than validation for search ranking.
            (
              (${SEARCH_DISTANCE_WEIGHT} * ${distanceScoreCase} +
                ${SEARCH_VALIDATION_WEIGHT} * COALESCE(v.avg_validation, 0.5)) *
              ${textScoreCase}
            ) AS pre_rank_score
          FROM pubkey_metadata m
          LEFT JOIN nsd_root_distances d ON m.pubkey = d.pubkey
          LEFT JOIN (
            SELECT
              pubkey,
              AVG(metric_value) AS avg_validation,
              COUNT(*) AS validation_count
            FROM profile_metrics
            WHERE expires_at > (EXTRACT(epoch FROM NOW())::INTEGER)
            GROUP BY pubkey
           ) v ON m.pubkey = v.pubkey
           WHERE
             m.created_at > $4 AND (
             m.name ILIKE '%' || $1 || '%' OR
             m.display_name ILIKE '%' || $1 || '%' OR
             m.nip05 ILIKE '%' || $1 || '%' OR
             m.lud16 ILIKE '%' || $1 || '%' OR
             m.about ILIKE '%' || $1 || '%'
             )
        )
        SELECT
          pubkey,
          text_score,
          is_exact_match,
          pre_rank_score,
          distance,
          validation_count
        FROM ranked_matches
        WHERE text_score > 0  -- Only return actual matches
        ORDER BY pre_rank_score DESC, text_score DESC, distance ASC
        LIMIT $2
        `,
          { 1: query, 2: candidateLimit, 3: decayFactor, 4: staleThreshold },
        );

        const rows = await result.getRows();

        return rows.map((row: unknown[], index) => {
          const rowArray = row as unknown[];
          let textScore = 0;
          if (
            rowArray[1] &&
            typeof (rowArray[1] as { toDouble: () => number }).toDouble ===
              "function"
          ) {
            textScore = (rowArray[1] as { toDouble: () => number }).toDouble();
          } else {
            textScore = Number(rowArray[1]);
          }

          let isExactMatch = false;
          if (rowArray[2] && typeof rowArray[2] === "boolean") {
            isExactMatch = rowArray[2] as boolean;
          } else if (
            rowArray[2] &&
            typeof (rowArray[2] as { toBoolean: () => boolean }).toBoolean ===
              "function"
          ) {
            isExactMatch = (
              rowArray[2] as { toBoolean: () => boolean }
            ).toBoolean();
          } else {
            isExactMatch = Boolean(rowArray[2]);
          }

          return {
            pubkey: rowArray[0] as string,
            score: textScore,
            rank: index + 1,
            isExactMatch: isExactMatch,
          };
        });
      });
    } catch (error) {
      logger.warn(
        `Failed to search metadata after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  async getStats(): Promise<{ totalEntries: number }> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.readConnection.run(
          "SELECT COUNT(*) as count FROM pubkey_metadata",
        );
        const rows = await result.getRows();
        // DuckDB returns columns by index, not by name
        const rowArray = rows[0] as unknown[];
        return { totalEntries: Number(rowArray[0] || 0) };
      });
    } catch (error) {
      logger.warn(
        `Failed to get metadata stats after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return { totalEntries: 0 };
    }
  }
}
