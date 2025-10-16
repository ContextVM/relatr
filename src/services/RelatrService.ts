import { Database } from 'bun:sqlite';
import { SocialGraphManager } from '../social-graph/SocialGraphManager.js';
import { DistanceNormalizer } from '../distance/DistanceNormalizer.js';
import { ProfileMetricsCollector } from '../metrics/ProfileMetricsCollector.js';
import { TrustScoreCalculator } from '../trust/TrustScoreCalculator.js';
import { getWeightingScheme } from '../trust/WeightingScheme.js';
import { config } from '../config/environment.js';
import { initializeDatabase, getDatabase, closeDatabase } from '../database/index.js';
import type { 
    TrustScoreCalculationRequest, 
    TrustScoreCalculationResult,
    BatchTrustScoreRequest,
    BatchTrustScoreResult,
    ServiceHealthStatus,
    ServiceStats,
    RelatrServiceConfig
} from './types';

/**
 * Main orchestrator service for Relatr trust score computation
 * Coordinates all modules to provide end-to-end trust score calculation
 */
export class RelatrService {
    private db!: Database;
    private graphManager!: SocialGraphManager;
    private normalizer!: DistanceNormalizer;
    private metricsCollector!: ProfileMetricsCollector;
    private calculator!: TrustScoreCalculator;
    private isInitialized = false;
    private config: RelatrServiceConfig;
    private initTime?: number;
    private operationCount = 0;
    private errorCount = 0;
    private lastHealthCheck?: number;

    constructor(config?: Partial<RelatrServiceConfig>) {
        this.config = {
            defaultSourcePubkey: config?.defaultSourcePubkey,
            enableMetrics: config?.enableMetrics ?? true,
            enableLogging: config?.enableLogging ?? true,
            logLevel: config?.logLevel || 'info',
            performanceMonitoring: config?.performanceMonitoring ?? true,
            ...config
        };
    }

    /**
     * Initialize all service components in the proper order
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            this.log('warn', 'RelatrService already initialized');
            return;
        }

        const startTime = Date.now();
        this.log('info', 'Initializing RelatrService...');

        try {
            // 1. Initialize database connection
            this.log('info', 'Initializing database connection...');
            this.db = initializeDatabase();
            
            // 2. Initialize social graph manager
            this.log('info', 'Initializing social graph manager...');
            this.graphManager = new SocialGraphManager({
                rootPubkey: this.config.defaultSourcePubkey!,
                graphBinaryPath: config.GRAPH_BINARY_PATH,
                autoSave: config.ENABLE_AUTO_SAVE,
                autoSaveInterval: config.AUTO_SAVE_INTERVAL,
            });
            await this.graphManager.initialize();
            
            // 3. Initialize distance normalizer
            this.log('info', 'Initializing distance normalizer...');
            this.normalizer = new DistanceNormalizer({
                decayFactor: config.DECAY_FACTOR,
                maxDistance: config.MAX_DISTANCE,
            });
            
            // 4. Initialize metrics collector
            this.log('info', 'Initializing profile metrics collector...');
            this.metricsCollector = new ProfileMetricsCollector(this.db, {
                relays: config.NOSTR_RELAYS,
                cacheTtlSeconds: config.PROFILE_METRICS_TTL,
                enableNip05: config.ENABLE_NIP05,
                enableLightning: config.ENABLE_LIGHTNING,
                enableEventKind10002: config.ENABLE_EVENT_KIND_10002,
                enableReciprocity: config.ENABLE_RECIPROCITY,
                validatorConfig: {
                    nip05: {
                        timeout: 5000,
                        retries: 2,
                        retryDelay: 1000,
                        enableLogging: this.config.enableLogging ?? true,
                        wellKnownTimeout: 3000,
                        verifySignature: true,
                    },
                    lightning: {
                        timeout: 5000,
                        retries: 2,
                        retryDelay: 1000,
                        enableLogging: this.config.enableLogging ?? true,
                        validateLnurl: false,
                        checkConnectivity: false,
                    },
                },
                cacheConfig: {
                    defaultTtl: config.PROFILE_METRICS_TTL,
                    maxEntries: 10000,
                    cleanupInterval: 300000, // 5 minutes
                    enableStats: this.config.enableMetrics ?? true,
                },
            });
            
            // Set graph manager for optimized reciprocity checks
            this.metricsCollector.setGraphManager(this.graphManager);
            
            // 5. Initialize trust score calculator
            this.log('info', 'Initializing trust score calculator...');
            this.calculator = new TrustScoreCalculator({
                weightingScheme: getWeightingScheme(config.WEIGHTING_SCHEME),
                cacheResults: true,
                cacheTtlSeconds: config.TRUST_SCORES_TTL,
            }, this.db);
            
            this.isInitialized = true;
            this.initTime = Date.now() - startTime;
            
            this.log('info', `RelatrService initialized successfully in ${this.initTime}ms`);
            
        } catch (error) {
            this.log('error', `Failed to initialize RelatrService: ${error}`);
            this.errorCount++;
            throw new Error(`RelatrService initialization failed: ${error}`);
        }
    }

    /**
     * Ensure service is initialized before operations
     */
    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('RelatrService not initialized. Call initialize() first.');
        }
    }

    /**
     * Calculate trust score for a single target pubkey
     */
    async calculateTrustScore(request: TrustScoreCalculationRequest): Promise<TrustScoreCalculationResult> {
        this.ensureInitialized();
        
        const startTime = Date.now();
        this.operationCount++;
        
        const {
            targetPubkey,
            sourcePubkey = this.config.defaultSourcePubkey!,
            scheme = 'default',
            forceRefresh = false
        } = request;

        this.log('info', `Calculating trust score for ${targetPubkey.substring(0, 8)}... from ${sourcePubkey.substring(0, 8)}...`);

        try {
            // 1. Switch root if needed (expensive operation, avoid if possible)
            const currentRoot = this.graphManager.getCurrentRoot();
            if (currentRoot !== sourcePubkey) {
                this.log('debug', `Switching graph root from ${currentRoot.substring(0, 8)}... to ${sourcePubkey.substring(0, 8)}...`);
                await this.graphManager.switchRoot(sourcePubkey);
            }

            // 2. Get distance from social graph
            const distance = this.graphManager.getFollowDistance(targetPubkey);
            this.log('debug', `Social graph distance: ${distance} hops`);

            // 3. Normalize distance
            const distanceWeight = this.normalizer.normalize(distance);
            this.log('debug', `Normalized distance weight: ${distanceWeight.toFixed(3)}`);

            // 4. Collect profile metrics
            const metricsResult = await this.metricsCollector.collectMetrics(
                targetPubkey, 
                sourcePubkey, 
                { forceRefresh }
            );
            
            this.log('debug', `Profile metrics collected (cache hit: ${metricsResult.cacheHit})`);

            // 5. Calculate trust score
            const weightingScheme = getWeightingScheme(scheme);
            this.calculator.setWeightingScheme(weightingScheme);

            const trustScoreResult = await this.calculator.calculate({
                distanceWeight,
                nip05Valid: metricsResult.metrics.nip05Valid,
                lightningAddress: metricsResult.metrics.lightningAddress,
                eventKind10002: metricsResult.metrics.eventKind10002,
                reciprocity: metricsResult.metrics.reciprocity,
            }, sourcePubkey, targetPubkey, { forceRefresh });

            const duration = Date.now() - startTime;

            const result: TrustScoreCalculationResult = {
                score: trustScoreResult.score,
                sourcePubkey,
                targetPubkey,
                scheme,
                metrics: {
                    distance,
                    distanceWeight,
                    nip05Valid: metricsResult.metrics.nip05Valid,
                    lightningAddress: metricsResult.metrics.lightningAddress,
                    eventKind10002: metricsResult.metrics.eventKind10002,
                    reciprocity: metricsResult.metrics.reciprocity,
                },
                computedAt: trustScoreResult.computedAt,
                cached: metricsResult.cacheHit,
                duration,
                breakdown: this.config.performanceMonitoring ? {
                    distanceQuery: 0, // Could be measured with more detailed timing
                    metricsCollection: 0,
                    scoreCalculation: 0,
                } : undefined,
            };

            this.log('info', `Trust score calculated: ${result.score.toFixed(3)} for ${targetPubkey.substring(0, 8)}... (${duration}ms)`);
            
            return result;

        } catch (error) {
            this.errorCount++;
            const duration = Date.now() - startTime;
            this.log('error', `Failed to calculate trust score for ${targetPubkey.substring(0, 8)}... (${duration}ms): ${error}`);
            
            throw new Error(`Trust score calculation failed: ${error}`);
        }
    }

    /**
     * Calculate trust scores for multiple target pubkeys
     */
    async calculateBatchTrustScores(request: BatchTrustScoreRequest): Promise<BatchTrustScoreResult> {
        this.ensureInitialized();
        
        const startTime = Date.now();
        const { targetPubkeys, sourcePubkey, scheme = 'default', forceRefresh = false } = request;
        
        this.log('info', `Calculating batch trust scores for ${targetPubkeys.length} pubkeys`);

        const results: TrustScoreCalculationResult[] = [];
        const errors: Array<{ pubkey: string; error: string }> = [];
        
        // Process in parallel with concurrency limit to avoid overwhelming resources
        const concurrencyLimit = 5;
        const chunks = this.chunkArray(targetPubkeys, concurrencyLimit);
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async (pubkey) => {
                try {
                    return await this.calculateTrustScore({
                        targetPubkey: pubkey,
                        sourcePubkey: sourcePubkey || this.config.defaultSourcePubkey!,
                        scheme,
                        forceRefresh,
                    });
                } catch (error: unknown) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    errors.push({ pubkey, error: errorMsg });
                    return null;
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults.filter((result: TrustScoreCalculationResult | null): result is TrustScoreCalculationResult => result !== null));
        }

        const duration = Date.now() - startTime;
        const successful = results.length;
        const failed = targetPubkeys.length - successful;
        
        this.log('info', `Batch calculation complete: ${successful}/${targetPubkeys.length} successful, ${failed} failed (${duration}ms)`);

        return {
            sourcePubkey: sourcePubkey || this.config.defaultSourcePubkey!,
            results,
            summary: {
                total: targetPubkeys.length,
                successful,
                failed,
                duration,
                averageDuration: duration / targetPubkeys.length,
            },
            errors: errors.length > 0 ? errors : undefined,
        };
    }

    /**
     * Get service health status
     */
    async getHealthStatus(): Promise<ServiceHealthStatus> {
        this.lastHealthCheck = Date.now();
        
        const status: ServiceHealthStatus = {
            healthy: true,
            initialized: this.isInitialized,
            uptime: this.isInitialized ? this.lastHealthCheck - (this.initTime || 0) : 0,
            components: {},
            stats: await this.getServiceStats(),
        };

        if (!this.isInitialized) {
            status.healthy = false;
            status.error = 'Service not initialized';
            return status;
        }

        try {
            // Check database
            status.components.database = {
                healthy: this.db !== undefined,
                details: this.db ? 'Connected' : 'Not connected'
            };

            // Check social graph
            status.components.socialGraph = {
                healthy: this.graphManager?.isManagerInitialized() || false,
                details: this.graphManager ? 'Initialized' : 'Not initialized'
            };

            // Check distance normalizer (always healthy if initialized)
            status.components.distanceNormalizer = {
                healthy: this.normalizer !== undefined,
                details: 'Ready'
            };

            // Check metrics collector
            status.components.metricsCollector = {
                healthy: this.metricsCollector !== undefined,
                details: 'Ready'
            };

            // Check trust calculator
            status.components.trustCalculator = {
                healthy: this.calculator !== undefined,
                details: 'Ready'
            };

            // Overall health is AND of all components
            status.healthy = Object.values(status.components).every((comp: any) => comp.healthy);

        } catch (error) {
            status.healthy = false;
            status.error = `Health check failed: ${error}`;
        }

        return status;
    }

    /**
     * Get service statistics
     */
    async getServiceStats(): Promise<ServiceStats> {
        const stats: ServiceStats = {
            initialized: this.isInitialized,
            uptime: this.isInitialized && this.initTime ? Date.now() - this.initTime : 0,
            operationCount: this.operationCount,
            errorCount: this.errorCount,
            errorRate: this.operationCount > 0 ? this.errorCount / this.operationCount : 0,
            lastHealthCheck: this.lastHealthCheck,
        };

        if (this.isInitialized) {
            try {
                // Get graph statistics
                if (this.graphManager) {
                    stats.graphStats = this.graphManager.getGraphStatistics();
                }

                // Get cache statistics
                if (this.metricsCollector) {
                    stats.metricsCacheStats = this.metricsCollector.getCacheStats();
                }

                if (this.calculator) {
                    const trustCacheStats = this.calculator.getCacheStats();
                    if (trustCacheStats) {
                        stats.trustCacheStats = trustCacheStats;
                    }
                }

                // Get database statistics
                if (this.db) {
                    const dbStats = this.db.query(`
                        SELECT 
                            COUNT(DISTINCT pubkey) as unique_pubkeys,
                            COUNT(*) as total_metrics,
                            MAX(computed_at) as last_computation
                        FROM profile_metrics
                    `).get() as any;
                    
                    stats.databaseStats = {
                        uniquePubkeys: dbStats.unique_pubkeys || 0,
                        totalMetrics: dbStats.total_metrics || 0,
                        lastComputation: dbStats.last_computation || 0,
                    };
                }

            } catch (error) {
                this.log('error', `Failed to collect service stats: ${error}`);
            }
        }

        return stats;
    }

    /**
     * Invalidate cache for a specific pubkey
     */
    async invalidateCache(targetPubkey: string): Promise<void> {
        this.ensureInitialized();
        
        this.log('info', `Invalidating cache for ${targetPubkey.substring(0, 8)}...`);
        
        try {
            await this.metricsCollector.invalidateCache(targetPubkey);
            
            // Invalidate trust score cache for all sources (more aggressive cleanup)
            if (this.calculator) {
                await this.calculator.invalidateAllCache(targetPubkey);
            }
            
            this.log('info', `Cache invalidated for ${targetPubkey.substring(0, 8)}...`);
        } catch (error) {
            this.log('error', `Failed to invalidate cache for ${targetPubkey.substring(0, 8)}...: ${error}`);
            throw error;
        }
    }

    /**
     * Clean up expired cache entries across all components
     */
    async cleanupCaches(): Promise<number> {
        this.ensureInitialized();
        
        this.log('info', 'Cleaning up expired cache entries...');
        
        let totalCleaned = 0;
        
        try {
            // Clean metrics cache
            if (this.metricsCollector) {
                const metricsCleaned = await this.metricsCollector.cleanupCache();
                totalCleaned += metricsCleaned;
                this.log('debug', `Cleaned ${metricsCleaned} expired metrics cache entries`);
            }

            // Clean trust score cache
            if (this.calculator) {
                const trustCleaned = await this.calculator.cleanupCache();
                totalCleaned += trustCleaned;
                this.log('debug', `Cleaned ${trustCleaned} expired trust score cache entries`);
            }
            
            this.log('info', `Cache cleanup complete: ${totalCleaned} entries removed`);
            
        } catch (error) {
            this.log('error', `Cache cleanup failed: ${error}`);
            throw error;
        }

        return totalCleaned;
    }

    /**
     * Gracefully shutdown the service
     */
    async shutdown(): Promise<void> {
        this.log('info', 'Shutting down RelatrService...');
        
        try {
            // Cleanup social graph
            if (this.graphManager) {
                await this.graphManager.cleanup();
            }

            // Cleanup metrics collector
            if (this.metricsCollector) {
                this.metricsCollector.cleanup();
            }

            // Close database connection
            if (this.db) {
                closeDatabase();
            }

            this.isInitialized = false;
            this.log('info', 'RelatrService shutdown complete');
            
        } catch (error) {
            this.log('error', `Error during shutdown: ${error}`);
            throw error;
        }
    }

    /**
     * Internal logging method
     */
    private log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
        if (!this.config.enableLogging) return;
        
        const timestamp = new Date().toISOString();
        const levelUpper = level.toUpperCase();
        
        // Only log if level is enabled
        if (level === 'debug' && this.config.logLevel !== 'debug') return;
        
        console.log(`[${timestamp}] ${levelUpper} [RelatrService] ${message}`);
    }

    /**
     * Utility: Split array into chunks
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Get current configuration (without sensitive data)
     */
    getConfig(): Omit<RelatrServiceConfig, 'defaultSourcePubkey'> & { 
        hasDefaultSourcePubkey: boolean;
        defaultSourcePubkeyPrefix?: string;
    } {
        return {
            hasDefaultSourcePubkey: !!this.config.defaultSourcePubkey,
            defaultSourcePubkeyPrefix: this.config.defaultSourcePubkey 
                ? this.config.defaultSourcePubkey.substring(0, 8) + '...' 
                : undefined,
            enableMetrics: this.config.enableMetrics,
            enableLogging: this.config.enableLogging,
            logLevel: this.config.logLevel,
            performanceMonitoring: this.config.performanceMonitoring,
        };
    }
}