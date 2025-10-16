import { Database } from 'bun:sqlite';
import type { TrustScoreResult, CacheStats, CacheEntry } from './types';

/**
 * Database layer for caching computed trust scores
 */
export class TrustScoreCache {
    private db: Database;
    private ttlSeconds: number;
    private stats: CacheStats;
    
    constructor(db: Database, ttlSeconds: number = 3600) {
        this.db = db;
        this.ttlSeconds = ttlSeconds;
        this.stats = {
            hits: 0,
            misses: 0,
            hitRate: 0,
            totalEntries: 0,
            expiredEntries: 0,
            lastCleanup: Date.now(),
        };
    }
    
    /**
     * Get cached trust score
     */
    async get(sourcePubkey: string, targetPubkey: string): Promise<TrustScoreResult | null> {
        const query = this.db.query(`
            SELECT 
                ts.score,
                ts.metric_weights,
                ts.metric_values,
                ts.computed_at,
                ts.expires_at
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            WHERE sp.pubkey = $sourcePubkey
                AND tp.pubkey = $targetPubkey
                AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            ORDER BY ts.computed_at DESC
            LIMIT 1
        `);
        
        const row = query.get({
            $sourcePubkey: sourcePubkey,
            $targetPubkey: targetPubkey,
        }) as any;
        
        if (!row) {
            this.stats.misses++;
            this.updateHitRate();
            return null;
        }
        
        this.stats.hits++;
        this.updateHitRate();
        
        return {
            score: row.score,
            metricValues: JSON.parse(row.metric_values),
            metricWeights: JSON.parse(row.metric_weights),
            computedAt: row.computed_at,
        };
    }
    
    /**
     * Save trust score to cache
     */
    async save(
        sourcePubkey: string,
        targetPubkey: string,
        result: TrustScoreResult
    ): Promise<void> {
        const transaction = this.db.transaction(() => {
            // Get or create pubkey IDs
            const sourceId = this.getOrCreatePubkeyId(sourcePubkey);
            const targetId = this.getOrCreatePubkeyId(targetPubkey);
            
            const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
            
            const query = this.db.query(`
                INSERT INTO trust_scores (
                    source_pubkey_id,
                    target_pubkey_id,
                    score,
                    computed_at,
                    expires_at,
                    metric_weights,
                    metric_values,
                    formula_version
                )
                VALUES ($sourceId, $targetId, $score, $computedAt, $expiresAt, $weights, $values, $version)
                ON CONFLICT(source_pubkey_id, target_pubkey_id, formula_version) DO UPDATE SET
                    score = $score,
                    computed_at = $computedAt,
                    expires_at = $expiresAt,
                    metric_weights = $weights,
                    metric_values = $values,
                    updated_at = unixepoch()
            `);
            
            query.run({
                $sourceId: sourceId,
                $targetId: targetId,
                $score: result.score,
                $computedAt: result.computedAt,
                $expiresAt: expiresAt,
                $weights: JSON.stringify(result.metricWeights),
                $values: JSON.stringify(result.metricValues),
                $version: 'v1',
            });
        });
        
        transaction();
        this.updateTotalEntries();
    }
    
    /**
     * Invalidate cache for a pubkey pair
     */
    async invalidate(sourcePubkey: string, targetPubkey: string): Promise<void> {
        const query = this.db.query(`
            DELETE FROM trust_scores
            WHERE source_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $sourcePubkey)
                AND target_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $targetPubkey)
        `);
        
        query.run({
            $sourcePubkey: sourcePubkey,
            $targetPubkey: targetPubkey,
        });
        
        this.updateTotalEntries();
    }
    
    /**
     * Invalidate all scores for a pubkey (as source or target)
     */
    async invalidateAll(pubkey: string): Promise<void> {
        const query = this.db.query(`
            DELETE FROM trust_scores
            WHERE source_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $pubkey)
                OR target_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $pubkey)
        `);
        
        query.run({ $pubkey: pubkey });
        
        this.updateTotalEntries();
    }
    
    /**
     * Get all cached scores for a source pubkey
     */
    async getScoresForSource(sourcePubkey: string): Promise<Array<{
        targetPubkey: string;
        score: number;
        computedAt: number;
        expiresAt?: number;
    }>> {
        const query = this.db.query(`
            SELECT 
                tp.pubkey as target_pubkey,
                ts.score,
                ts.computed_at,
                ts.expires_at
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            WHERE sp.pubkey = $sourcePubkey
                AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            ORDER BY ts.score DESC
        `);
        
        const rows = query.all({ $sourcePubkey: sourcePubkey }) as any[];
        
        return rows.map(row => ({
            targetPubkey: row.target_pubkey,
            score: row.score,
            computedAt: row.computed_at,
            expiresAt: row.expires_at,
        }));
    }
    
    /**
     * Get all cached scores for a target pubkey
     */
    async getScoresForTarget(targetPubkey: string): Promise<Array<{
        sourcePubkey: string;
        score: number;
        computedAt: number;
        expiresAt?: number;
    }>> {
        const query = this.db.query(`
            SELECT 
                sp.pubkey as source_pubkey,
                ts.score,
                ts.computed_at,
                ts.expires_at
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            WHERE tp.pubkey = $targetPubkey
                AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            ORDER BY ts.score DESC
        `);
        
        const rows = query.all({ $targetPubkey: targetPubkey }) as any[];
        
        return rows.map(row => ({
            sourcePubkey: row.source_pubkey,
            score: row.score,
            computedAt: row.computed_at,
            expiresAt: row.expires_at,
        }));
    }
    
    /**
     * Clean up expired entries
     */
    async cleanup(): Promise<number> {
        const query = this.db.query(`
            DELETE FROM trust_scores
            WHERE expires_at IS NOT NULL AND expires_at < unixepoch()
        `);
        
        const result = query.run();
        const deletedCount = result.changes || 0;
        
        this.stats.expiredEntries = deletedCount;
        this.stats.lastCleanup = Date.now();
        this.updateTotalEntries();
        
        return deletedCount;
    }
    
    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        return { ...this.stats };
    }
    
    /**
     * Reset cache statistics
     */
    resetStats(): void {
        this.stats = {
            hits: 0,
            misses: 0,
            hitRate: 0,
            totalEntries: this.stats.totalEntries,
            expiredEntries: 0,
            lastCleanup: Date.now(),
        };
    }
    
    /**
     * Check if a cache entry exists and is valid
     */
    async exists(sourcePubkey: string, targetPubkey: string): Promise<boolean> {
        const query = this.db.query(`
            SELECT 1
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            WHERE sp.pubkey = $sourcePubkey
                AND tp.pubkey = $targetPubkey
                AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            LIMIT 1
        `);
        
        const row = query.get({
            $sourcePubkey: sourcePubkey,
            $targetPubkey: targetPubkey,
        }) as any;
        
        return !!row;
    }
    
    /**
     * Get cache entry with metadata
     */
    async getEntry(sourcePubkey: string, targetPubkey: string): Promise<CacheEntry | null> {
        const result = await this.get(sourcePubkey, targetPubkey);
        
        if (!result) {
            return null;
        }
        
        return {
            sourcePubkey,
            targetPubkey,
            result,
            expiresAt: Math.floor(Date.now() / 1000) + this.ttlSeconds,
        };
    }
    
    /**
     * Get all cache entries (for debugging/monitoring)
     */
    async getAllEntries(limit: number = 100): Promise<CacheEntry[]> {
        const query = this.db.query(`
            SELECT 
                sp.pubkey as source_pubkey,
                tp.pubkey as target_pubkey,
                ts.score,
                ts.metric_weights,
                ts.metric_values,
                ts.computed_at,
                ts.expires_at
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            ORDER BY ts.computed_at DESC
            LIMIT $limit
        `);
        
        const rows = query.all({ $limit: limit }) as any[];
        
        return rows.map(row => ({
            sourcePubkey: row.source_pubkey,
            targetPubkey: row.target_pubkey,
            result: {
                score: row.score,
                metricValues: JSON.parse(row.metric_values),
                metricWeights: JSON.parse(row.metric_weights),
                computedAt: row.computed_at,
            },
            expiresAt: row.expires_at,
        }));
    }
    
    /**
     * Batch invalidate multiple pubkey pairs
     */
    async batchInvalidate(pairs: Array<{sourcePubkey: string; targetPubkey: string}>): Promise<number> {
        let deletedCount = 0;
        
        for (const pair of pairs) {
            const query = this.db.query(`
                DELETE FROM trust_scores
                WHERE source_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $sourcePubkey)
                    AND target_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $targetPubkey)
            `);
            
            const result = query.run({
                $sourcePubkey: pair.sourcePubkey,
                $targetPubkey: pair.targetPubkey,
            });
            
            deletedCount += result.changes || 0;
        }
        
        this.updateTotalEntries();
        return deletedCount;
    }
    
    // Private helper methods
    
    private getOrCreatePubkeyId(pubkey: string): number {
        const selectQuery = this.db.query(`
            SELECT id FROM pubkeys WHERE pubkey = $pubkey
        `);
        
        const existing = selectQuery.get({ $pubkey: pubkey }) as any;
        if (existing) {
            return existing.id;
        }
        
        const insertQuery = this.db.query(`
            INSERT INTO pubkeys (pubkey, first_seen_at, last_updated_at)
            VALUES ($pubkey, unixepoch(), unixepoch())
        `);
        
        const result = insertQuery.run({ $pubkey: pubkey });
        return result.lastInsertRowid as number;
    }
    
    private updateHitRate(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
    }
    
    private updateTotalEntries(): void {
        const query = this.db.query(`
            SELECT COUNT(*) as count FROM trust_scores
            WHERE expires_at IS NULL OR expires_at > unixepoch()
        `);
        
        const row = query.get() as any;
        this.stats.totalEntries = row?.count || 0;
    }
}