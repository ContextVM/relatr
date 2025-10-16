import { Database } from 'bun:sqlite';
import type { 
    ProfileMetrics, 
    MetricsCacheEntry, 
    MetricsCacheConfig, 
    CacheStats,
    MetricType
} from '../types';
import { MetricsError, MetricsErrorCodes, METRIC_TYPES } from '../types';

/**
 * Database-backed cache for profile validation metrics
 * Provides TTL-based expiration and cache statistics
 */
export class MetricsCache {
    private db: Database;
    private config: MetricsCacheConfig;
    private stats: CacheStats;
    private cleanupTimer?: NodeJS.Timeout;
    
    constructor(db: Database, config?: Partial<MetricsCacheConfig>) {
        this.db = db;
        this.config = {
            defaultTtl: 3600,        // 1 hour default
            maxEntries: 10000,       // Maximum cache entries
            cleanupInterval: 3600000, // 1 hour cleanup interval
            enableStats: true,       // Enable cache statistics
            ...config,
        };
        
        this.stats = {
            hits: 0,
            misses: 0,
            total: 0,
            hitRate: 0,
            lastReset: Math.floor(Date.now() / 1000),
        };
        
        // Initialize database indexes if needed
        this.initializeIndexes();
        
        // Start periodic cleanup
        this.startPeriodicCleanup();
    }
    
    /**
     * Save profile metrics to database cache
     */
    async saveMetrics(pubkey: string, metrics: ProfileMetrics, ttl?: number): Promise<void> {
        try {
            const ttlSeconds = ttl || this.config.defaultTtl;
            const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
            
            const transaction = this.db.transaction(() => {
                // Get or create pubkey record
                const pubkeyId = this.getOrCreatePubkeyId(pubkey);
                
                // Get metric IDs
                const metricIds = this.getMetricIds();
                
                // Save each metric with its own expiration
                // Use snake_case keys to match database column names
                if (metricIds.nip05_valid !== undefined) {
                    this.saveMetric(pubkeyId, metricIds.nip05_valid, metrics.nip05Valid, expiresAt);
                }
                if (metricIds.lightning_address !== undefined) {
                    this.saveMetric(pubkeyId, metricIds.lightning_address, metrics.lightningAddress, expiresAt);
                }
                if (metricIds.event_kind_10002 !== undefined) {
                    this.saveMetric(pubkeyId, metricIds.event_kind_10002, metrics.eventKind10002, expiresAt);
                }
                if (metricIds.reciprocity !== undefined) {
                    this.saveMetric(pubkeyId, metricIds.reciprocity, metrics.reciprocity, expiresAt);
                }
                
                // Enforce cache size limits
                this.enforceCacheLimits();
            });
            
            transaction();
            
            if (this.config.enableStats) {
                this.stats.total++;
            }
            
        } catch (error) {
            throw new MetricsError(
                `Failed to save metrics for pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Get cached profile metrics for a pubkey
     */
    async getMetrics(pubkey: string): Promise<ProfileMetrics | null> {
        try {
            const query = this.db.query(`
                SELECT 
                    pm.metric_id,
                    md.metric_name,
                    pm.value,
                    pm.computed_at,
                    pm.expires_at
                FROM profile_metrics pm
                JOIN metric_definitions md ON pm.metric_id = md.id
                JOIN pubkeys p ON pm.pubkey_id = p.id
                WHERE p.pubkey = $pubkey
                    AND md.metric_type != 'distance'
                    AND (pm.expires_at IS NULL OR pm.expires_at > unixepoch())
            `);
            
            const rows = query.all({ $pubkey: pubkey }) as any[];
            
            if (rows.length === 0) {
                if (this.config.enableStats) {
                    this.stats.misses++;
                    this.updateHitRate();
                }
                return null;
            }
            
            if (this.config.enableStats) {
                this.stats.hits++;
                this.updateHitRate();
            }
            
            const metrics: ProfileMetrics = {
                pubkey,
                nip05Valid: 0.0,
                lightningAddress: 0.0,
                eventKind10002: 0.0,
                reciprocity: 0.0,
                computedAt: rows[0].computed_at,
            };
            
            for (const row of rows) {
                switch (row.metric_name) {
                    case METRIC_TYPES.NIP05_VALID:
                        metrics.nip05Valid = row.value;
                        break;
                    case METRIC_TYPES.LIGHTNING_ADDRESS:
                        metrics.lightningAddress = row.value;
                        break;
                    case METRIC_TYPES.EVENT_KIND_10002:
                        metrics.eventKind10002 = row.value;
                        break;
                    case METRIC_TYPES.RECIPROCITY:
                        metrics.reciprocity = row.value;
                        break;
                }
            }
            
            return metrics;
            
        } catch (error) {
            throw new MetricsError(
                `Failed to get metrics for pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Get a single metric value for a pubkey
     */
    async getMetric(pubkey: string, metricType: MetricType): Promise<number | null> {
        try {
            const query = this.db.query(`
                SELECT pm.value, pm.expires_at
                FROM profile_metrics pm
                JOIN metric_definitions md ON pm.metric_id = md.id
                JOIN pubkeys p ON pm.pubkey_id = p.id
                WHERE p.pubkey = $pubkey
                    AND md.metric_name = $metricName
                    AND (pm.expires_at IS NULL OR pm.expires_at > unixepoch())
            `);
            
            const row = query.get({ 
                $pubkey: pubkey, 
                $metricName: metricType 
            }) as any;
            
            if (!row) {
                if (this.config.enableStats) {
                    this.stats.misses++;
                    this.updateHitRate();
                }
                return null;
            }
            
            if (this.config.enableStats) {
                this.stats.hits++;
                this.updateHitRate();
            }
            
            return row.value;
            
        } catch (error) {
            throw new MetricsError(
                `Failed to get metric ${metricType} for pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Check if cached metrics are expired
     */
    isExpired(metrics: ProfileMetrics): boolean {
        const now = Math.floor(Date.now() / 1000);
        return metrics.computedAt + this.config.defaultTtl < now;
    }
    
    /**
     * Check if a specific metric is expired
     */
    async isMetricExpired(pubkey: string, metricType: MetricType): Promise<boolean> {
        try {
            const query = this.db.query(`
                SELECT pm.expires_at
                FROM profile_metrics pm
                JOIN metric_definitions md ON pm.metric_id = md.id
                JOIN pubkeys p ON pm.pubkey_id = p.id
                WHERE p.pubkey = $pubkey
                    AND md.metric_name = $metricName
            `);
            
            const row = query.get({ 
                $pubkey: pubkey, 
                $metricName: metricType 
            }) as any;
            
            if (!row) {
                return true; // No cached entry = expired
            }
            
            if (!row.expires_at) {
                return false; // No expiration set = not expired
            }
            
            const now = Math.floor(Date.now() / 1000);
            return row.expires_at < now;
            
        } catch (error) {
            throw new MetricsError(
                `Failed to check expiration for metric ${metricType} of pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Invalidate all metrics for a pubkey
     */
    async invalidate(pubkey: string): Promise<void> {
        try {
            const query = this.db.query(`
                DELETE FROM profile_metrics
                WHERE pubkey_id = (
                    SELECT id FROM pubkeys WHERE pubkey = $pubkey
                )
            `);
            
            const result = query.run({ $pubkey: pubkey });
            
            if (this.config.enableStats) {
                console.log(`Cache: Invalidated ${result.changes} metrics for pubkey ${pubkey.substring(0, 8)}...`);
            }
            
        } catch (error) {
            throw new MetricsError(
                `Failed to invalidate cache for pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Invalidate a specific metric for a pubkey
     */
    async invalidateMetric(pubkey: string, metricType: MetricType): Promise<void> {
        try {
            const query = this.db.query(`
                DELETE FROM profile_metrics
                WHERE pubkey_id = (
                    SELECT id FROM pubkeys WHERE pubkey = $pubkey
                )
                AND metric_id = (
                    SELECT id FROM metric_definitions WHERE metric_name = $metricName
                )
            `);
            
            const result = query.run({ 
                $pubkey: pubkey, 
                $metricName: metricType 
            });
            
            if (this.config.enableStats) {
                console.log(`Cache: Invalidated metric ${metricType} for pubkey ${pubkey.substring(0, 8)}...`);
            }
            
        } catch (error) {
            throw new MetricsError(
                `Failed to invalidate metric ${metricType} for pubkey ${pubkey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache',
                pubkey
            );
        }
    }
    
    /**
     * Clean up expired entries
     */
    async cleanup(): Promise<number> {
        try {
            const query = this.db.query(`
                DELETE FROM profile_metrics
                WHERE expires_at IS NOT NULL AND expires_at < unixepoch()
            `);
            
            const result = query.run();
            
            if (this.config.enableStats && result.changes > 0) {
                console.log(`Cache: Cleaned up ${result.changes} expired entries`);
            }
            
            return result.changes || 0;
            
        } catch (error) {
            throw new MetricsError(
                `Failed to cleanup cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache'
            );
        }
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
            total: 0,
            hitRate: 0,
            lastReset: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Get cache size information
     */
    async getCacheInfo(): Promise<{
        totalEntries: number;
        expiredEntries: number;
        maxEntries: number;
        utilization: number;
    }> {
        try {
            // Get total entries
            const totalQuery = this.db.query(`
                SELECT COUNT(*) as count FROM profile_metrics
            `);
            const totalResult = totalQuery.get() as any;
            const totalEntries = totalResult.count || 0;
            
            // Get expired entries
            const expiredQuery = this.db.query(`
                SELECT COUNT(*) as count FROM profile_metrics
                WHERE expires_at IS NOT NULL AND expires_at < unixepoch()
            `);
            const expiredResult = expiredQuery.get() as any;
            const expiredEntries = expiredResult.count || 0;
            
            return {
                totalEntries,
                expiredEntries,
                maxEntries: this.config.maxEntries,
                utilization: totalEntries / this.config.maxEntries,
            };
            
        } catch (error) {
            throw new MetricsError(
                `Failed to get cache info: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.CACHE_ERROR,
                'cache'
            );
        }
    }
    
    /**
     * Update hit rate calculation
     */
    private updateHitRate(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
    }
    
    /**
     * Initialize database indexes for performance
     */
    private initializeIndexes(): void {
        try {
            // Create indexes for cache performance if they don't exist
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey_expires 
                ON profile_metrics(pubkey_id, expires_at);
                
                CREATE INDEX IF NOT EXISTS idx_profile_metrics_expires_only 
                ON profile_metrics(expires_at);
            `);
        } catch (error) {
            console.warn('Failed to create cache indexes:', error);
        }
    }
    
    /**
     * Get or create pubkey ID
     */
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
    
    /**
     * Get metric IDs by name
     */
    private getMetricIds(): Record<string, number> {
        const query = this.db.query(`
            SELECT id, metric_name FROM metric_definitions
            WHERE metric_name IN ('nip05_valid', 'lightning_address', 'event_kind_10002', 'reciprocity')
        `);
        
        const rows = query.all() as Array<{ id: number; metric_name: string }>;
        const ids: Record<string, number> = {};
        
        for (const row of rows) {
            ids[row.metric_name] = row.id;
        }
        
        return ids;
    }
    
    /**
     * Save a single metric value
     */
    private saveMetric(
        pubkeyId: number,
        metricId: number,
        value: number,
        expiresAt: number
    ): void {
        const query = this.db.query(`
            INSERT INTO profile_metrics (pubkey_id, metric_id, value, computed_at, expires_at)
            VALUES ($pubkeyId, $metricId, $value, unixepoch(), $expiresAt)
            ON CONFLICT(pubkey_id, metric_id) DO UPDATE SET
                value = $value,
                computed_at = unixepoch(),
                expires_at = $expiresAt,
                updated_at = unixepoch()
        `);
        
        query.run({
            $pubkeyId: pubkeyId,
            $metricId: metricId,
            $value: value,
            $expiresAt: expiresAt,
        });
    }
    
    /**
     * Enforce cache size limits using LRU eviction
     */
    private enforceCacheLimits(): void {
        try {
            // Check current cache size
            const countQuery = this.db.query(`
                SELECT COUNT(*) as count FROM profile_metrics
            `);
            const result = countQuery.get() as any;
            const currentSize = result.count || 0;
            
            if (currentSize <= this.config.maxEntries) {
                return;
            }
            
            // Remove oldest entries to stay within limits
            const excessCount = currentSize - this.config.maxEntries;
            const deleteQuery = this.db.query(`
                DELETE FROM profile_metrics
                WHERE id IN (
                    SELECT id FROM profile_metrics
                    ORDER BY updated_at ASC
                    LIMIT $limit
                )
            `);
            
            const deleteResult = deleteQuery.run({ $limit: excessCount });
            
            if (this.config.enableStats && deleteResult.changes > 0) {
                console.log(`Cache: Evicted ${deleteResult.changes} old entries to enforce size limits`);
            }
            
        } catch (error) {
            console.warn('Failed to enforce cache limits:', error);
        }
    }
    
    /**
     * Start periodic cleanup timer
     */
    private startPeriodicCleanup(): void {
        if (this.config.cleanupInterval > 0) {
            this.cleanupTimer = setInterval(async () => {
                try {
                    await this.cleanup();
                } catch (error) {
                    console.error('Periodic cache cleanup failed:', error);
                }
            }, this.config.cleanupInterval);
        }
    }
    
    /**
     * Stop periodic cleanup timer
     */
    stopPeriodicCleanup(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
    }
    
    /**
     * Cleanup resources
     */
    destroy(): void {
        this.stopPeriodicCleanup();
    }
}