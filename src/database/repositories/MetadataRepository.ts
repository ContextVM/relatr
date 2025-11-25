import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type NostrProfile } from "../../types";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "../../utils/Logger";

export interface SearchResult {
  pubkey: string;
  score: number;
  rank: number;
  isExactMatch: boolean;
}

export class MetadataRepository {
  private connection: DuckDBConnection;

  constructor(connection: DuckDBConnection) {
    this.connection = connection;
  }

  async save(profile: NostrProfile): Promise<void> {
    try {
      return await executeWithRetry(async () => {
        const now = Math.floor(Date.now() / 1000);

        // Delete existing
        await this.connection.run(
          "DELETE FROM pubkey_metadata WHERE pubkey = $1",
          { 1: profile.pubkey },
        );

        // Insert new
        await this.connection.run(
          `INSERT INTO pubkey_metadata (pubkey, name, display_name, nip05, lud16, about, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          {
            1: profile.pubkey,
            2: profile.name || null,
            3: profile.display_name || null,
            4: profile.nip05 || null,
            5: profile.lud16 || null,
            6: profile.about || null,
            7: now,
          },
        );
      });
    } catch (error) {
      logger.warn(
        `Failed to save metadata for ${profile.pubkey} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new DatabaseError(
        `Failed to save metadata for ${profile.pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "METADATA_SAVE",
      );
    }
  }

  async get(pubkey: string): Promise<NostrProfile | null> {
    try {
      return await executeWithRetry(async () => {
        const result = await this.connection.run(
          `SELECT pubkey, name, display_name, nip05, lud16, about
           FROM pubkey_metadata
           WHERE pubkey = $1`,
          { 1: pubkey },
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
        // Calculate candidate limit: return enough candidates for trust calculation
        // but not so many that we process thousands of profiles
        const candidateLimit = Math.max(limit * 20, 100);

        const result = await this.connection.run(
          `
        WITH ranked_matches AS (
          SELECT
            m.pubkey,
            m.name,
            m.display_name,
            m.nip05,
            -- Text relevance scoring with priority for exact and prefix matches
            CASE
              -- Exact matches (highest priority) - entire field equals query
              WHEN LOWER(m.name) = LOWER($1) THEN 1.4
              WHEN LOWER(m.display_name) = LOWER($1) THEN 1.3
              WHEN LOWER(m.nip05) = LOWER($1) THEN 1.2
              -- Prefix matches (high priority)
              WHEN m.name ILIKE $1 || '%' THEN 1.1
              WHEN m.display_name ILIKE $1 || '%' THEN 1.05
              WHEN m.nip05 ILIKE $1 || '%' THEN 1.0
              -- Contains matches (lower priority)
              WHEN m.name ILIKE '%' || $1 || '%' THEN 0.9
              WHEN m.display_name ILIKE '%' || $1 || '%' THEN 0.8
              WHEN m.nip05 ILIKE '%' || $1 || '%' THEN 0.7
              ELSE 0.0
            END AS text_score,
            -- Exact match flag
            CASE
              WHEN LOWER(m.name) = LOWER($1) OR LOWER(m.display_name) = LOWER($1) THEN true
              ELSE false
            END AS is_exact_match,
            -- Social distance score (exponential decay matching TrustCalculator)
            CASE
              WHEN d.distance <= 1 THEN 1.0
              WHEN d.distance = 1000 THEN 0.0
              ELSE exp(-$3 * d.distance)
            END AS distance_score,
            d.distance,
            -- Validation score (average of all metrics for this pubkey)
            COALESCE(v.avg_validation, 0.5) AS validation_score,
            v.validation_count,
            -- Pre-rank score: combines distance, validation, and text relevance
            -- Formula mirrors trust calculation: (0.5×distance + 0.5×validation) × text_relevance
            (
              (0.5 * CASE
                WHEN d.distance <= 1 THEN 1.0
                WHEN d.distance = 1000 THEN 0.0
                ELSE exp(-$3 * d.distance)
              END +
                0.5 * COALESCE(v.avg_validation, 0.5)) *
              CASE
                WHEN LOWER(m.name) = LOWER($1) THEN 1.4
                WHEN LOWER(m.display_name) = LOWER($1) THEN 1.3
                WHEN LOWER(m.nip05) = LOWER($1) THEN 1.2
                WHEN m.name ILIKE $1 || '%' THEN 1.1
                WHEN m.display_name ILIKE $1 || '%' THEN 1.05
                WHEN m.nip05 ILIKE $1 || '%' THEN 1.0
                WHEN m.name ILIKE '%' || $1 || '%' THEN 0.9
                WHEN m.display_name ILIKE '%' || $1 || '%' THEN 0.8
                WHEN m.nip05 ILIKE '%' || $1 || '%' THEN 0.7
                ELSE 0.0
              END
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
            m.name ILIKE '%' || $1 || '%' OR
            m.display_name ILIKE '%' || $1 || '%' OR
            m.nip05 ILIKE '%' || $1 || '%'
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
          { 1: query, 2: candidateLimit, 3: decayFactor },
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
        const result = await this.connection.run(
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
