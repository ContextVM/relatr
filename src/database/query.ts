import { Database } from "bun:sqlite";
import { getDatabase } from "./connection";

/**
 * Database helper class with common operations
 */
export class DatabaseHelper {
    private db: Database;

    constructor(db?: Database) {
        this.db = db || getDatabase();
    }

    /**
     * Get or create a pubkey record
     */
    getOrCreatePubkey(pubkey: string): number {
        const now = Math.floor(Date.now() / 1000);
        
        // Try to get existing pubkey
        const existing = this.db.query(
            "SELECT id FROM pubkeys WHERE pubkey = $pubkey"
        ).get({ $pubkey: pubkey }) as { id: number } | undefined;

        if (existing) {
            // Update last_updated_at
            this.db.query(
                "UPDATE pubkeys SET last_updated_at = $last_updated_at WHERE id = $id"
            ).run({ $last_updated_at: now, $id: existing.id });
            
            return existing.id;
        }

        // Create new pubkey
        const result = this.db.query(
            "INSERT INTO pubkeys (pubkey, first_seen_at, last_updated_at) VALUES ($pubkey, $first_seen_at, $last_updated_at)"
        ).run({
            $pubkey: pubkey,
            $first_seen_at: now,
            $last_updated_at: now
        });

        return Number(result.lastInsertRowid);
    }

    /**
     * Get profile metrics for a pubkey
     */
    getProfileMetrics(pubkeyId: number): any[] {
        return this.db.query(`
            SELECT 
                md.metric_name,
                md.metric_type,
                pm.value,
                pm.computed_at,
                pm.expires_at,
                pm.metadata
            FROM profile_metrics pm
            JOIN metric_definitions md ON pm.metric_id = md.id
            WHERE pm.pubkey_id = $pubkey_id
              AND (pm.expires_at IS NULL OR pm.expires_at > unixepoch())
              AND md.is_active = 1
        `).all({ $pubkey_id: pubkeyId });
    }

    /**
     * Get trust score for a pubkey pair
     */
    getTrustScore(sourcePubkeyId: number, targetPubkeyId: number): any | undefined {
        return this.db.query(`
            SELECT 
                ts.score,
                ts.computed_at,
                ts.expires_at,
                ts.metric_weights,
                ts.metric_values,
                ts.formula_version
            FROM trust_scores ts
            WHERE ts.source_pubkey_id = $source_pubkey_id
              AND ts.target_pubkey_id = $target_pubkey_id
              AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            ORDER BY ts.computed_at DESC
            LIMIT 1
        `).get({
            $source_pubkey_id: sourcePubkeyId,
            $target_pubkey_id: targetPubkeyId
        });
    }

    /**
     * Clean up expired entries
     */
    cleanupExpired(): void {
        const cleanup = this.db.transaction(() => {
            // Clean up expired profile metrics
            this.db.run(
                "DELETE FROM profile_metrics WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()"
            );

            // Clean up expired trust scores
            this.db.run(
                "DELETE FROM trust_scores WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()"
            );

            // Clean up expired nostr events
            this.db.run(
                "DELETE FROM nostr_events_cache WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()"
            );
        });
        
        cleanup();
    }

    /**
     * Insert trust score
     */
    insertTrustScore(params: {
        sourcePubkeyId: number;
        targetPubkeyId: number;
        score: number;
        metricWeights: string;
        metricValues: string;
        formulaVersion?: string;
    }): number {
        const result = this.db.query(`
            INSERT INTO trust_scores (
                source_pubkey_id, target_pubkey_id, score, computed_at,
                metric_weights, metric_values, formula_version
            ) VALUES (
                $source_pubkey_id, $target_pubkey_id, $score, $computed_at,
                $metric_weights, $metric_values, $formula_version
            )
        `).run({
            $source_pubkey_id: params.sourcePubkeyId,
            $target_pubkey_id: params.targetPubkeyId,
            $score: params.score,
            $computed_at: Math.floor(Date.now() / 1000),
            $metric_weights: params.metricWeights,
            $metric_values: params.metricValues,
            $formula_version: params.formulaVersion || 'v1'
        });

        return Number(result.lastInsertRowid);
    }

    /**
     * Insert or update profile metric
     */
    upsertProfileMetric(params: {
        pubkeyId: number;
        metricName: string;
        value: number;
        metadata?: string;
        expiresAt?: number;
    }): void {
        const now = Math.floor(Date.now() / 1000);
        
        // Get metric ID
        const metric = this.db.query(
            "SELECT id FROM metric_definitions WHERE metric_name = $metric_name"
        ).get({ $metric_name: params.metricName }) as { id: number } | undefined;

        if (!metric) {
            throw new Error(`Metric not found: ${params.metricName}`);
        }

        // Insert or replace
        this.db.query(`
            INSERT OR REPLACE INTO profile_metrics 
            (pubkey_id, metric_id, value, computed_at, expires_at, metadata, updated_at)
            VALUES ($pubkey_id, $metric_id, $value, $computed_at, $expires_at, $metadata, $updated_at)
        `).run({
            $pubkey_id: params.pubkeyId,
            $metric_id: metric.id,
            $value: params.value,
            $computed_at: now,
            $expires_at: params.expiresAt || null,
            $metadata: params.metadata || null,
            $updated_at: now
        });
    }

    /**
     * Get configuration value
     */
    getConfig(key: string): string | undefined {
        const result = this.db.query(
            "SELECT config_value FROM configuration WHERE config_key = $config_key"
        ).get({ $config_key: key }) as { config_value: string } | undefined;
        
        return result?.config_value;
    }

    /**
     * Set configuration value
     */
    setConfig(key: string, value: string, valueType: string): void {
        this.db.query(`
            INSERT OR REPLACE INTO configuration (config_key, config_value, value_type, updated_at)
            VALUES ($config_key, $config_value, $value_type, $updated_at)
        `).run({
            $config_key: key,
            $config_value: value,
            $value_type: valueType,
            $updated_at: Math.floor(Date.now() / 1000)
        });
    }

    /**
     * Count records in a table
     */
    count(table: string, where: string = "", params: Record<string, any> = {}): number {
        const sql = `SELECT COUNT(*) as count FROM ${table}${where ? ` WHERE ${where}` : ""}`;
        const result = this.db.query(sql).get(params) as { count: number } | undefined;
        return result?.count || 0;
    }

    /**
     * Check if a record exists
     */
    exists(sql: string, params: Record<string, any> = {}): boolean {
        const result = this.db.query(`SELECT COUNT(*) as count FROM (${sql})`).get(params) as { count: number } | undefined;
        return (result?.count || 0) > 0;
    }
}

/**
 * Export singleton instance
 */
export const db = new DatabaseHelper();

/**
 * Export direct database access for advanced usage
 */
export function getRawDatabase(): Database {
    return getDatabase();
}