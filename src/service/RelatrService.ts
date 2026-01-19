import { validateAndDecodePubkey } from '@/utils/utils.nostr';
import type {
    CalculateTrustScoreParams,
    RelatrConfig,
    SearchProfilesParams,
    SearchProfilesResult,
    StatsResult,
    TrustScore,
    ScoreComponents
} from '../types';
import { ValidationError, RelatrError } from '../types';
import type { RelatrServiceDependencies, IRelatrService } from './ServiceInterfaces';
import type { TAService } from './TAService';
import { logger } from '../utils/Logger';
import { isHexKey } from 'applesauce-core/helpers';
import { MetricDescriptionRegistry } from '../validators/MetricDescriptionRegistry';

export class RelatrService implements IRelatrService {
    private initialized = false;
    private config: RelatrConfig;
    private socialGraph: RelatrServiceDependencies['socialGraph'];
    private metricsValidator: RelatrServiceDependencies['metricsValidator'];
    private trustCalculator: RelatrServiceDependencies['trustCalculator'];
    private searchService: RelatrServiceDependencies['searchService'];
    private schedulerService: RelatrServiceDependencies['schedulerService'];
    private dbManager: RelatrServiceDependencies['dbManager'];
    private metadataRepository: RelatrServiceDependencies['metadataRepository'];
    private taService: TAService | undefined;

    constructor(dependencies: RelatrServiceDependencies) {
        this.config = dependencies.config;
        this.socialGraph = dependencies.socialGraph;
        this.metricsValidator = dependencies.metricsValidator;
        this.trustCalculator = dependencies.trustCalculator;
        this.searchService = dependencies.searchService;
        this.schedulerService = dependencies.schedulerService;
        this.dbManager = dependencies.dbManager;
        this.metadataRepository = dependencies.metadataRepository;
        this.taService = dependencies.taService;
        this.initialized = true;
    }

    /**
     * Set TA service for lazy TA refresh after trust computation
     * This is called after TA service is created to avoid circular dependency
     */
    setTAService(taService: RelatrServiceDependencies['taService']): void {
        this.taService = taService;
    }

    async calculateTrustScore(params: CalculateTrustScoreParams, enableLazyRefresh: boolean = true): Promise<TrustScore> {
        // Validate and decode target pubkey once
        const decodedTargetPubkey = validateAndDecodePubkey(params.targetPubkey);
        if (!decodedTargetPubkey) {
            throw new ValidationError('Invalid target pubkey format. Must be hex, npub, or nprofile', 'targetPubkey');
        }
       
        const result = await this.calculateTrustScoresBatch( {
            sourcePubkey: params.sourcePubkey,
            targetPubkeys: [decodedTargetPubkey]
        }, enableLazyRefresh).then(results => results.get(decodedTargetPubkey));
        
        if (!result) {
            throw new RelatrError('Trust calculation failed: missing trust score result', 'CALCULATE_TRUST');
        }
        
        // Enrich with metric descriptions
        const metricDescriptions = this.metricsValidator.getMetricDescriptions();
        return this.enrichTrustScoreWithDescriptions(result, metricDescriptions);
    }

    /**
     * Calculate trust scores for multiple target pubkeys in a single batch.
     *
     * Notes:
     * - Inputs may be hex, npub, or nprofile; all are decoded to hex internally.
     * - When enableLazyRefresh is true, triggers TA refresh for all targets after computation (non-blocking).
     */
    async calculateTrustScoresBatch(params: {
        sourcePubkey?: string;
        targetPubkeys: string[];
    }, enableLazyRefresh: boolean = true): Promise<Map<string, TrustScore>> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');

        const { sourcePubkey, targetPubkeys } = params;

        if (!targetPubkeys || !Array.isArray(targetPubkeys) || targetPubkeys.length === 0) {
            throw new ValidationError('Invalid target pubkeys', 'targetPubkeys');
        }

        // Validate targets - assume they're already decoded hex from callers
        const decodedTargetPubkeys: string[] = [];
        for (const targetPubkey of targetPubkeys) {
            if (!targetPubkey || typeof targetPubkey !== 'string') {
                throw new ValidationError('Invalid target pubkey', 'targetPubkeys');
            }
            // Skip re-decoding if it's already hex (64 char hex string)
            if (isHexKey(targetPubkey)) {
                decodedTargetPubkeys.push(targetPubkey);
            } else {
                // Fallback: decode if caller passed non-hex format
                const decoded = validateAndDecodePubkey(targetPubkey);
                if (!decoded) {
                    throw new ValidationError('Invalid target pubkey format. Must be hex, npub, or nprofile', 'targetPubkeys');
                }
                decodedTargetPubkeys.push(decoded);
            }
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        if (!effectiveSourcePubkey || typeof effectiveSourcePubkey !== 'string') {
            throw new ValidationError('Invalid source pubkey', 'sourcePubkey');
        }

        const decodedSourcePubkey = validateAndDecodePubkey(effectiveSourcePubkey);
        if (!decodedSourcePubkey) {
            throw new ValidationError('Invalid source pubkey format. Must be hex, npub, or nprofile', 'sourcePubkey');
        }

        try {
            // Pre-fetch distances + metrics in parallel
            const [distances, metricsMap] = await Promise.all([
                this.socialGraph.getDistancesBatch(decodedTargetPubkeys),
                this.metricsValidator.validateAllBatch(decodedTargetPubkeys, decodedSourcePubkey),
            ]);

            // Get metric descriptions once for all trust scores
            const metricDescriptions = this.metricsValidator.getMetricDescriptions();

            const trustScores = new Map<string, TrustScore>();

            for (const targetHex of decodedTargetPubkeys) {
                const distance = distances.get(targetHex) ?? 1000;
                const metrics = metricsMap.get(targetHex);

                if (!metrics) {
                    // validateAllBatch should return a metrics object for each pubkey, but keep safe behavior.
                    continue;
                }

                const trustScore = this.trustCalculator.calculate(
                    decodedSourcePubkey,
                    targetHex,
                    metrics,
                    distance ?? 1000,
                );

                // Enrich trust score with metric descriptions
                const enrichedTrustScore = this.enrichTrustScoreWithDescriptions(trustScore, metricDescriptions);
                trustScores.set(targetHex, enrichedTrustScore);
            }

            // Trigger lazy TA refresh after trust computation (non-blocking, best-effort)
            if (enableLazyRefresh && this.taService) {
                // Process pubkeys in batches to limit concurrency
                const CONCURRENCY_LIMIT = 5;
                
                for (let i = 0; i < decodedTargetPubkeys.length; i += CONCURRENCY_LIMIT) {
                    const batchStart = i;
                    const batchEnd = Math.min(i + CONCURRENCY_LIMIT, decodedTargetPubkeys.length);
                    
                    // Fire promises directly without intermediate array allocation
                    for (let j = batchStart; j < batchEnd; j++) {
                        const pubkey = decodedTargetPubkeys[j]!; // Safe: bounds checked by loop
                        this.taService.maybeRefreshAndEnqueueTA(pubkey).catch((error) => {
                            logger.warn(
                                `Failed lazy TA refresh for ${pubkey}:`,
                                error instanceof Error ? error.message : String(error),
                            );
                        });
                    }
                }
            }

            return trustScores;
        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError) {
                throw error;
            }
            throw new RelatrError(`Trust calculation failed: ${error instanceof Error ? error.message : String(error)}`, 'CALCULATE_TRUST');
        }
    }

    async searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        if (!this.metadataRepository) throw new RelatrError('Metadata repository not initialized', 'DATABASE_NOT_INITIALIZED');
        
        try {
            return await this.searchService.searchProfiles(params);
        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError) {
                throw error;
            }
            throw new RelatrError(`Search failed: ${error instanceof Error ? error.message : String(error)}`, 'SEARCH_FAILED');
        }
    }

    async getStats(): Promise<StatsResult> {
        const timestamp = Math.floor(Date.now() / 1000);

        try {
            // Get database stats
            let metricsStats = { totalEntries: 0 };
            let metadataTotalEntries = 0;

            if (this.schedulerService) {
                metricsStats = await this.schedulerService.getMetricsStats();
            }

            if (this.metadataRepository) {
                const metadataStats = await this.metadataRepository.getStats();
                metadataTotalEntries = metadataStats.totalEntries;
            }

            // Get social graph stats
            let socialGraphStats: StatsResult['socialGraph']['stats'] = { users: 0, follows: 0};
            let rootPubkey = "";

            if (this.socialGraph) {
                const fullStats = await this.socialGraph.getStats();
                socialGraphStats = {
                    users: fullStats.users,
                    follows: fullStats.follows,
                };
                rootPubkey = this.socialGraph.getCurrentRoot();
            }

            return {
                timestamp,
                sourcePubkey: this.config.defaultSourcePubkey,
                database: {
                    metrics: metricsStats,
                    metadata: { totalEntries: metadataTotalEntries }
                },
                socialGraph: {
                    stats: socialGraphStats,
                    rootPubkey
                }
            };
        } catch {
            // Return minimal stats on error
            return {
                timestamp,
                sourcePubkey: this.config.defaultSourcePubkey,
                database: {
                    metrics: { totalEntries: 0 },
                    metadata: { totalEntries: 0 }
                },
                socialGraph: {
                    stats: { users: 0, follows: 0 },
                    rootPubkey: ""
                }
            };
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
        if (!this.initialized) return;

        try {
            await this.schedulerService?.stop();
            
            if (this.dbManager) {
                await this.dbManager.close();
            }
            
            this.initialized = false;
            logger.info('✅ RelatrService shutdown completed');
        } catch (error) {
            logger.error('Cleanup error:', error instanceof Error ? error.message : String(error));
            throw new RelatrError(`Cleanup error: ${error instanceof Error ? error.message : String(error)}`, 'CLEANUP');
        }
    }

    getConfig(): RelatrConfig {
        return { ...this.config };
    }
    
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Enrich trust score with metric descriptions
     * Adds description field to validator scores
     * @param trustScore - Trust score to enrich
     * @param metricDescriptions - Metric description registry
     * @returns Enriched trust score with descriptions
     * @private
     */
    private enrichTrustScoreWithDescriptions(
        trustScore: TrustScore,
        metricDescriptions: MetricDescriptionRegistry
    ): TrustScore {
        const enrichedValidators: ScoreComponents['validators'] = {};
        
        for (const [name, validator] of Object.entries(trustScore.components.validators)) {
            // TrustCalculator now returns { score: number } format
            // Just add the description field
            enrichedValidators[name] = {
                score: validator.score,
                description: metricDescriptions.get(name),
            };
        }

        return {
            ...trustScore,
            components: {
                ...trustScore.components,
                validators: enrichedValidators,
            },
        };
    }
}