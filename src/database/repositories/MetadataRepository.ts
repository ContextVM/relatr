import { DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, type NostrProfile } from "../../types";

export interface SearchResult {
  pubkey: string;
  profile: NostrProfile;
  score: number;
  rank: number;
}

export class MetadataRepository {
  private connection: DuckDBConnection;

  constructor(connection: DuckDBConnection) {
    this.connection = connection;
  }

  async save(profile: NostrProfile): Promise<void> {
    try {
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
    } catch (error) {
      throw new DatabaseError(
        `Failed to save metadata for ${profile.pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "METADATA_SAVE",
      );
    }
  }

  async get(pubkey: string): Promise<NostrProfile | null> {
    try {
      const result = await this.connection.run(
        `SELECT pubkey, name, display_name, nip05, lud16, about
         FROM pubkey_metadata
         WHERE pubkey = $1`,
        { 1: pubkey },
      );

      const rows = await result.getRows();
      if (rows.length === 0) return null;

      const row = rows[0] as any[];
      return {
        pubkey: row[0],
        name: row[1],
        display_name: row[2],
        nip05: row[3],
        lud16: row[4],
        about: row[5],
      };
    } catch (error) {
      throw new DatabaseError(
        `Failed to get metadata for ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "METADATA_GET",
      );
    }
  }

  async search(query: string, limit: number = 20): Promise<SearchResult[]> {
    try {
      const searchPattern = `%${query}%`;
      const result = await this.connection.run(
        `
        SELECT
          pubkey, name, display_name, nip05, lud16, about,
          (CASE
            WHEN name ILIKE $1 THEN 1.0
            WHEN display_name ILIKE $1 THEN 0.8
            WHEN nip05 ILIKE $1 THEN 0.6
            WHEN about ILIKE $1 THEN 0.4
            ELSE 0.1
          END) as score
        FROM pubkey_metadata
        WHERE
          name ILIKE $1 OR
          display_name ILIKE $1 OR
          nip05 ILIKE $1 OR
          about ILIKE $1
        ORDER BY score DESC
        LIMIT $2
      `,
        {
          1: searchPattern,
          2: limit,
        },
      );

      const rows = await result.getRows();
      console.log(
        `DEBUG: MetadataRepository.search(${query}, ${limit}): Found ${rows.length} rows`,
      );
      return rows.map((row: any[], index) => {
        let score = 0;
        if (row[6] && typeof row[6].toDouble === "function") {
          score = row[6].toDouble();
        } else {
          score = Number(row[6]);
        }

        return {
          pubkey: row[0],
          profile: {
            pubkey: row[0],
            name: row[1],
            display_name: row[2],
            nip05: row[3],
            lud16: row[4],
            about: row[5],
          },
          score: score,
          rank: index + 1,
        };
      });
    } catch (error) {
      console.warn("FTS search failed:", error);
      return [];
    }
  }

  async getStats(): Promise<{ totalEntries: number }> {
    try {
      const result = await this.connection.run(
        "SELECT COUNT(*) as count FROM pubkey_metadata",
      );
      const rows = await result.getRows();
      // DuckDB returns columns by index, not by name
      const values = Object.values(rows[0] as any);
      return { totalEntries: Number(values[0] || 0) };
    } catch (error) {
      return { totalEntries: 0 };
    }
  }
}
