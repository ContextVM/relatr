import { Database } from 'bun:sqlite';
import { SimplePool } from 'nostr-tools/pool';
import type { SocialGraphManager } from '../social-graph/SocialGraphManager';
import { Nip05Validator } from './validators/Nip05Validator.js';
import { LightningValidator } from './validators/LightningValidator.js';
import { EventValidator } from './validators/EventValidator.js';
import { ReciprocityValidator } from './validators/ReciprocityValidator.js';
import { MetricsCache } from './cache/MetricsCache.js';
import type {
    ProfileMetrics,
    ProfileMetricsCollectionResult,
    ProfileMetricsConfig,
    MetricCollectionOptions,
    BatchMetricCollectionRequest,
    BatchMetricCollectionResult,
    NostrProfile,
    Nip05Result,
    LightningResult,
    EventResult,
    ReciprocityResult
} from './types';
import { MetricsError, MetricsErrorCodes } from './types';

/**
 * Main Profile Metrics Collector orchestrator
 * Coordinates all validators and manages caching for profile validation metrics
 */
export class ProfileMetricsCollector {
    private db: Database;
    private pool: SimplePool;
    private cache: MetricsCache;
    private config: ProfileMetricsConfig;
    
    // Validators
    private nip05Validator: Nip05Validator;
    private lightningValidator: LightningValidator;
    private eventValidator: EventValidator;
    private reciprocityValidator: ReciprocityValidator;
    
    // Optional social graph manager for optimized reciprocity checks
    private graphManager?: SocialGraphManager;
    
    constructor(db: Database, config: ProfileMetricsConfig) {
        this.db = db;
        this.config = config;
        
        // Initialize Nostr pool
        this.pool = new SimplePool();
        
        // Initialize cache
        this.cache = new MetricsCache(db, config.cacheConfig);
        
        // Initialize validators
        this.nip05Validator = new Nip05Validator(config.validatorConfig.nip05);
        this.lightningValidator = new LightningValidator(config.validatorConfig.lightning);
        this.eventValidator = new EventValidator(this.pool, config.relays);
        this.reciprocityValidator = new ReciprocityValidator(this.pool, config.relays);
    }
    
    /**
     * Set social graph manager for optimized reciprocity checks
     */
    setGraphManager(graphManager: SocialGraphManager): void {
        this.graphManager = graphManager;
        this.reciprocityValidator.setGraphManager(graphManager);
    }
    
    /**
     * Collect all metrics for a pubkey
     * Uses cache when available and not expired
     */
    async collectMetrics(
        targetPubkey: string,
        sourcePubkey?: string,
        options: MetricCollectionOptions = {}
    ): Promise<ProfileMetricsCollectionResult> {
        const startTime = Date.now();
        const {
            forceRefresh = false,
            timeout = 10000,
            retries = 2,
            parallel = true,
            includeDetails = true
        } = options;
        
        try {
            // Try to get from cache first (unless force refresh)
            if (!forceRefresh) {
                const cached = await this.cache.getMetrics(targetPubkey);
                if (cached && !this.cache.isExpired(cached)) {
                    console.log(`Using cached metrics for ${targetPubkey.substring(0, 8)}...`);
                    
                    return {
                        pubkey: targetPubkey,
                        sourcePubkey,
                        metrics: cached,
                        details: includeDetails ? {} as any : undefined,
                        collectedAt: Math.floor(Date.now() / 1000),
                        cacheHit: true,
                    };
                }
            }
            
            // Compute fresh metrics
            console.log(`Computing fresh metrics for ${targetPubkey.substring(0, 8)}...`);
            const result = await this.computeMetrics(targetPubkey, sourcePubkey, {
                timeout,
                retries,
                parallel,
                includeDetails
            });
            
            // Cache the results
            await this.cache.saveMetrics(targetPubkey, result.metrics);
            
            return {
                ...result,
                collectedAt: Math.floor(Date.now() / 1000),
                cacheHit: false,
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            console.error(`Failed to collect metrics for ${targetPubkey.substring(0, 8)}... (${duration}ms):`, error);
            
            // Return error result
            return {
                pubkey: targetPubkey,
                sourcePubkey,
                metrics: {
                    pubkey: targetPubkey,
                    nip05Valid: 0.0,
                    lightningAddress: 0.0,
                    eventKind10002: 0.0,
                    reciprocity: 0.0,
                    computedAt: Math.floor(Date.now() / 1000),
                },
                details: includeDetails ? {} as any : undefined,
                collectedAt: Math.floor(Date.now() / 1000),
                cacheHit: false,
                errors: [error instanceof Error ? error.message : 'Unknown error'],
            };
        }
    }
    
    /**
     * Compute all enabled metrics fresh (bypass cache)
     */
    private async computeMetrics(
        targetPubkey: string,
        sourcePubkey?: string,
        options: {
            timeout: number;
            retries: number;
            parallel: boolean;
            includeDetails: boolean;
        } = { timeout: 10000, retries: 2, parallel: true, includeDetails: true }
    ): Promise<Omit<ProfileMetricsCollectionResult, 'collectedAt' | 'cacheHit'>> {
        const metrics: ProfileMetrics = {
            pubkey: targetPubkey,
            nip05Valid: 0.0,
            lightningAddress: 0.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        const details: {
            nip05?: Nip05Result;
            lightning?: LightningResult;
            event?: EventResult;
            reciprocity?: ReciprocityResult;
        } = {};
        
        const errors: string[] = [];
        
        // Fetch profile metadata (kind 0) for NIP-05 and Lightning
        const profile = await this.fetchProfile(targetPubkey);
        
        if (options.parallel) {
            // Compute metrics in parallel
            const promises: Promise<void>[] = [];
            
            if (this.config.enableNip05 && profile) {
                promises.push(
                    this.computeNip05Metric(profile, targetPubkey, details, errors)
                );
            }
            
            if (this.config.enableLightning && profile) {
                promises.push(
                    this.computeLightningMetric(profile, details, errors)
                );
            }
            
            if (this.config.enableEventKind10002) {
                promises.push(
                    this.computeEventMetric(targetPubkey, details, errors)
                );
            }
            
            if (this.config.enableReciprocity && sourcePubkey) {
                promises.push(
                    this.computeReciprocityMetric(sourcePubkey, targetPubkey, details, errors)
                );
            }
            
            // Wait for all metrics to complete
            await Promise.all(promises);
            
        } else {
            // Compute metrics sequentially
            if (this.config.enableNip05 && profile) {
                await this.computeNip05Metric(profile, targetPubkey, details, errors);
            }
            
            if (this.config.enableLightning && profile) {
                await this.computeLightningMetric(profile, details, errors);
            }
            
            if (this.config.enableEventKind10002) {
                await this.computeEventMetric(targetPubkey, details, errors);
            }
            
            if (this.config.enableReciprocity && sourcePubkey) {
                await this.computeReciprocityMetric(sourcePubkey, targetPubkey, details, errors);
            }
        }
        
        // Update metrics from details
        if (details.nip05) {
            metrics.nip05Valid = details.nip05.valid ? 1.0 : 0.0;
        }
        
        if (details.lightning) {
            metrics.lightningAddress = details.lightning.hasAddress && details.lightning.validFormat ? 1.0 : 0.0;
        }
        
        if (details.event) {
            metrics.eventKind10002 = details.event.hasEvent ? 1.0 : 0.0;
        }
        
        if (details.reciprocity) {
            metrics.reciprocity = details.reciprocity.isReciprocal ? 1.0 : 0.0;
        }
        
        return {
            pubkey: targetPubkey,
            sourcePubkey,
            metrics,
            details: options.includeDetails ? details : undefined,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    
    /**
     * Compute NIP-05 metric
     */
    private async computeNip05Metric(
        profile: NostrProfile,
        pubkey: string,
        details: { nip05?: Nip05Result },
        errors: string[]
    ): Promise<void> {
        try {
            const result = await this.nip05Validator.validateWithPubkey(profile.nip05!, pubkey);
            details.nip05 = result;
        } catch (error) {
            const errorMsg = `NIP-05 validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(errorMsg);
        }
    }
    
    /**
     * Compute Lightning metric
     */
    private async computeLightningMetric(
        profile: NostrProfile,
        details: { lightning?: LightningResult },
        errors: string[]
    ): Promise<void> {
        try {
            const result = await this.lightningValidator.validateWithDetails(profile);
            details.lightning = result;
        } catch (error) {
            const errorMsg = `Lightning validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(errorMsg);
        }
    }
    
    /**
     * Compute Event metric
     */
    private async computeEventMetric(
        pubkey: string,
        details: { event?: EventResult },
        errors: string[]
    ): Promise<void> {
        try {
            const result = await this.eventValidator.validateRelayListMetadata(pubkey);
            details.event = result;
        } catch (error) {
            const errorMsg = `Event validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(errorMsg);
        }
    }
    
    /**
     * Compute Reciprocity metric
     */
    private async computeReciprocityMetric(
        sourcePubkey: string,
        targetPubkey: string,
        details: { reciprocity?: ReciprocityResult },
        errors: string[]
    ): Promise<void> {
        try {
            const result = await this.reciprocityValidator.validateReciprocity(sourcePubkey, targetPubkey);
            details.reciprocity = result;
        } catch (error) {
            const errorMsg = `Reciprocity validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(errorMsg);
        }
    }
    
    /**
     * Fetch profile metadata (kind 0) for a pubkey
     */
    private async fetchProfile(pubkey: string): Promise<NostrProfile | null> {
        try {
            const event = await this.pool.get(this.config.relays, {
                kinds: [0],
                authors: [pubkey],
            });
            
            if (!event || !event.content) {
                return null;
            }
            
            // Parse JSON content
            const profile = JSON.parse(event.content) as NostrProfile;
            return profile;
        } catch (error) {
            console.error(`Failed to fetch profile for ${pubkey.substring(0, 8)}...:`, error);
            return null;
        }
    }
    
    /**
     * Batch collect metrics for multiple pubkeys
     */
    async collectBatch(request: BatchMetricCollectionRequest): Promise<BatchMetricCollectionResult> {
        const startTime = Date.now();
        const { targetPubkeys, sourcePubkey, options = {} } = request;
        
        console.log(`Batch collecting metrics for ${targetPubkeys.length} pubkeys`);
        
        const results: ProfileMetricsCollectionResult[] = [];
        const errors: Array<{ pubkey: string; error: string }> = [];
        
        // Process in parallel with concurrency limit
        const concurrencyLimit = options.parallel !== false ? 3 : 1;
        const chunks = this.chunkArray(targetPubkeys, concurrencyLimit);
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async (pubkey) => {
                try {
                    return await this.collectMetrics(pubkey, sourcePubkey, options);
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                    errors.push({ pubkey, error: errorMsg });
                    
                    // Return error result
                    return {
                        pubkey,
                        sourcePubkey,
                        metrics: {
                            pubkey,
                            nip05Valid: 0.0,
                            lightningAddress: 0.0,
                            eventKind10002: 0.0,
                            reciprocity: 0.0,
                            computedAt: Math.floor(Date.now() / 1000),
                        },
                        details: options.includeDetails ? {} : undefined,
                        collectedAt: Math.floor(Date.now() / 1000),
                        cacheHit: false,
                        errors: [errorMsg],
                    } as ProfileMetricsCollectionResult;
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
        }
        
        const duration = Date.now() - startTime;
        const successful = results.filter(r => !r.errors || r.errors.length === 0).length;
        const cacheHits = results.filter(r => r.cacheHit).length;
        
        console.log(
            `Batch collection complete: ${successful}/${targetPubkeys.length} successful, ` +
            `${cacheHits} cache hits, ${duration}ms`
        );
        
        return {
            results,
            summary: {
                total: targetPubkeys.length,
                successful,
                failed: targetPubkeys.length - successful,
                cacheHits,
                duration,
            },
            errors,
        };
    }
    
    /**
     * Get a single metric value
     */
    async getMetric(
        pubkey: string,
        metricName: keyof Omit<ProfileMetrics, 'pubkey' | 'computedAt'>,
        sourcePubkey?: string,
        options: MetricCollectionOptions = {}
    ): Promise<number> {
        const metrics = await this.collectMetrics(pubkey, sourcePubkey, options);
        return metrics.metrics[metricName] ?? 0.0;
    }
    
    /**
     * Invalidate cached metrics for a pubkey
     */
    async invalidateCache(pubkey: string): Promise<void> {
        await this.cache.invalidate(pubkey);
    }
    
    /**
     * Invalidate a specific metric for a pubkey
     */
    async invalidateMetric(pubkey: string, metricType: keyof Omit<ProfileMetrics, 'pubkey' | 'computedAt'>): Promise<void> {
        // Convert metric name to metric type
        const metricTypeMap: Record<keyof Omit<ProfileMetrics, 'pubkey' | 'computedAt'>, string> = {
            nip05Valid: 'nip05_valid',
            lightningAddress: 'lightning_address',
            eventKind10002: 'event_kind_10002',
            reciprocity: 'reciprocity',
        };
        
        const metricTypeString = metricTypeMap[metricType];
        if (metricTypeString) {
            await this.cache.invalidateMetric(pubkey, metricTypeString as any);
        }
    }
    
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.cache.getStats();
    }
    
    /**
     * Reset cache statistics
     */
    resetCacheStats(): void {
        this.cache.resetStats();
    }
    
    /**
     * Clean up expired cache entries
     */
    async cleanupCache(): Promise<number> {
        return this.cache.cleanup();
    }
    
    /**
     * Get cache information
     */
    async getCacheInfo() {
        return this.cache.getCacheInfo();
    }
    
    /**
     * Force refresh metrics for a pubkey
     */
    async refreshMetrics(pubkey: string, sourcePubkey?: string): Promise<ProfileMetricsCollectionResult> {
        await this.invalidateCache(pubkey);
        return this.collectMetrics(pubkey, sourcePubkey, { forceRefresh: true });
    }
    
    /**
     * Get collector configuration
     */
    getConfig(): ProfileMetricsConfig {
        return { ...this.config };
    }
    
    /**
     * Update collector configuration
     */
    updateConfig(config: Partial<ProfileMetricsConfig>): void {
        this.config = { ...this.config, ...config };
        
        // Update validator configurations
        if (config.validatorConfig?.nip05) {
            this.nip05Validator.updateConfig(config.validatorConfig.nip05);
        }
        
        if (config.validatorConfig?.lightning) {
            this.lightningValidator.updateConfig(config.validatorConfig.lightning);
        }
        
        if (config.relays) {
            this.eventValidator.updateRelays(config.relays);
            this.reciprocityValidator.updateRelays(config.relays);
        }
    }
    
    /**
     * Cleanup resources
     */
    cleanup(): void {
        this.pool.close(this.config.relays);
        this.cache.destroy();
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
}