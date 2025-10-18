import type {
    RelatrConfig,
    CalculateTrustScoreParams,
    TrustScore,
    HealthCheckResult,
    ManageCacheResult,
    MetricWeights,
    ProfileMetrics
} from '../types';
import { 
    RelatrError, 
    DatabaseError, 
    SocialGraphError, 
    ValidationError,
    CacheError 
} from '../types';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, cleanupExpiredCache, isDatabaseHealthy } from '../database/connection';
import { SimpleCache } from '../database/cache';
import { SocialGraph } from '../graph/SocialGraph';
import { TrustCalculator } from '../trust/TrustCalculator';
import { MetricsValidator } from '../validators/MetricsValidator';
import { getWeightingPreset } from '../config';

export class RelatrService {
    private config: RelatrConfig;
    private db: Database | null = null;
    private socialGraph: SocialGraph | null = null;
    private trustCalculator: TrustCalculator | null = null;
    private metricsValidator: MetricsValidator | null = null;
    private metricsCache: SimpleCache<ProfileMetrics> | null = null;
    private trustScoreCache: SimpleCache<TrustScore> | null = null;
    private initialized = false;

    constructor(config: RelatrConfig) {
        if (!config) throw new RelatrError('Configuration required', 'CONSTRUCTOR');
        
        // Inline validation
        const required = ['defaultSourcePubkey', 'graphBinaryPath', 'databasePath'] as const;
        for (const field of required) {
            if (!config[field] || typeof config[field] !== 'string') {
                throw new ValidationError(`${field} required`, field);
            }
        }
        if (!config.nostrRelays?.length || !Array.isArray(config.nostrRelays)) {
            throw new ValidationError('nostrRelays required', 'nostrRelays');
        }
        if (typeof config.decayFactor !== 'number' || config.decayFactor < 0) {
            throw new ValidationError('Invalid decayFactor', 'decayFactor');
        }
        if (typeof config.cacheTtlSeconds !== 'number' || config.cacheTtlSeconds <= 0) {
            throw new ValidationError('Invalid cacheTtlSeconds', 'cacheTtlSeconds');
        }
        if (!config.weights || typeof config.weights !== 'object') {
            throw new ValidationError('weights required', 'weights');
        }
        
        this.config = { ...config };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            this.db = initDatabase(this.config.databasePath);
            this.metricsCache = new SimpleCache('profile_metrics', this.config.cacheTtlSeconds);
            this.trustScoreCache = new SimpleCache('trust_scores', this.config.cacheTtlSeconds);
            this.socialGraph = new SocialGraph(this.config.graphBinaryPath);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            this.trustCalculator = new TrustCalculator(this.config, this.trustScoreCache);
            this.metricsValidator = new MetricsValidator(this.config.nostrRelays, this.socialGraph, this.metricsCache);
            this.initialized = true;
        } catch (error) {
            await this.cleanup();
            throw new RelatrError(`Init failed: ${error instanceof Error ? error.message : String(error)}`, 'INITIALIZE');
        }
    }

    async calculateTrustScore(params: CalculateTrustScoreParams): Promise<TrustScore> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');

        const { sourcePubkey, targetPubkey, weightingScheme, customWeights } = params;
        
        if (!targetPubkey || typeof targetPubkey !== 'string') {
            throw new ValidationError('Invalid target pubkey', 'targetPubkey');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        if (!effectiveSourcePubkey || typeof effectiveSourcePubkey !== 'string') {
            throw new ValidationError('Invalid source pubkey', 'sourcePubkey');
        }

        try {
            const cacheKey: [string, string] = [effectiveSourcePubkey, targetPubkey];
            const cached = await this.trustScoreCache!.get(cacheKey);
            if (cached) return cached;

            const distance = effectiveSourcePubkey !== this.socialGraph!.getCurrentRoot()
                ? await this.socialGraph!.getDistanceBetween(effectiveSourcePubkey, targetPubkey)
                : this.socialGraph!.getDistance(targetPubkey);

            const metrics = await this.metricsValidator!.validateAll(targetPubkey, effectiveSourcePubkey);
            const weights = weightingScheme ? getWeightingPreset(weightingScheme) : customWeights;

            const trustScore = await this.trustCalculator!.calculate(
                effectiveSourcePubkey, targetPubkey, metrics, distance, weights
            );
            await this.trustScoreCache!.set(cacheKey, trustScore);
            return trustScore;

        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError || 
                error instanceof SocialGraphError || error instanceof CacheError) {
                throw error;
            }
            throw new RelatrError(`Calc failed: ${error instanceof Error ? error.message : String(error)}`, 'CALCULATE');
        }
    }

    async healthCheck(): Promise<HealthCheckResult> {
        const timestamp = Math.floor(Date.now() / 1000);
        try {
            const database = this.db ? isDatabaseHealthy(this.db) : false;
            const socialGraph = this.socialGraph?.isInitialized() || false;
            return { status: (database && socialGraph) ? 'healthy' : 'unhealthy', database, socialGraph, timestamp };
        } catch {
            return { status: 'unhealthy', database: false, socialGraph: false, timestamp };
        }
    }

    async manageCache(action: 'clear' | 'cleanup' | 'stats', targetPubkey?: string): Promise<ManageCacheResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');

        try {
            switch (action) {
                case 'clear': {
                    const metricsCleared = targetPubkey 
                        ? await this.metricsCache!.clear(targetPubkey)
                        : await this.metricsCache!.clear();
                    const scoresCleared = targetPubkey
                        ? await this.trustScoreCache!.clear([targetPubkey, ''])
                        : await this.trustScoreCache!.clear();
                    
                    return {
                        success: true,
                        metricsCleared,
                        scoresCleared,
                        message: targetPubkey ? `Cleared ${targetPubkey}` : 'Cleared all'
                    };
                }
                case 'cleanup': {
                    const metricsDeleted = await this.metricsCache!.cleanup();
                    const scoresDeleted = await this.trustScoreCache!.cleanup();
                    const dbCleanup = cleanupExpiredCache(this.db!);

                    return {
                        success: true,
                        metricsCleared: metricsDeleted + dbCleanup.metricsDeleted,
                        scoresCleared: scoresDeleted + dbCleanup.scoresDeleted,
                        message: `Cleaned ${metricsDeleted + dbCleanup.metricsDeleted} metrics, ${scoresDeleted + dbCleanup.scoresDeleted} scores`
                    };
                }
                case 'stats': {
                    const metricsStats = await this.metricsCache!.getStats();
                    const scoresStats = await this.trustScoreCache!.getStats();

                    return {
                        success: true,
                        message: `Metrics: ${metricsStats.totalEntries}/${metricsStats.expiredEntries}, Scores: ${scoresStats.totalEntries}/${scoresStats.expiredEntries}`
                    };
                }
                default:
                    throw new ValidationError(`Invalid action: ${action}`, 'action');
            }
        } catch (error) {
            if (error instanceof ValidationError || error instanceof CacheError) throw error;
            throw new CacheError(`Cache failed: ${error instanceof Error ? error.message : String(error)}`, action);
        }
    }

    async shutdown(): Promise<void> {
        try {
            await this.cleanup();
        } catch (error) {
            throw new RelatrError(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`, 'SHUTDOWN');
        }
    }

    private async cleanup(): Promise<void> {
        this.metricsValidator?.cleanup();
        this.socialGraph?.cleanup();
        if (this.db) closeDatabase(this.db);
        
        this.db = null;
        this.socialGraph = null;
        this.trustCalculator = null;
        this.metricsValidator = null;
        this.metricsCache = null;
        this.trustScoreCache = null;
        this.initialized = false;
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): SocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }
}