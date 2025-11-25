import { validateAndDecodePubkey } from '@/utils/utils.nostr';
import type {
    CalculateTrustScoreParams,
    RelatrConfig,
    SearchProfilesParams,
    SearchProfilesResult,
    StatsResult,
    TrustScore
} from '../types';
import { ValidationError, RelatrError } from '../types';
import type { RelatrServiceDependencies, IRelatrService } from './ServiceInterfaces';
import { logger } from '../utils/Logger';

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

    constructor(dependencies: RelatrServiceDependencies) {
        this.config = dependencies.config;
        this.socialGraph = dependencies.socialGraph;
        this.metricsValidator = dependencies.metricsValidator;
        this.trustCalculator = dependencies.trustCalculator;
        this.searchService = dependencies.searchService;
        this.schedulerService = dependencies.schedulerService;
        this.dbManager = dependencies.dbManager;
        this.metadataRepository = dependencies.metadataRepository;
        this.initialized = true;
    }

    async calculateTrustScore(params: CalculateTrustScoreParams): Promise<TrustScore> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        
        const { sourcePubkey, targetPubkey, weightingScheme } = params;

        if (!targetPubkey || typeof targetPubkey !== 'string') {
            throw new ValidationError('Invalid target pubkey', 'targetPubkey');
        }

        // Decode target pubkey from any supported format (hex, npub, nprofile)
        const decodedTargetPubkey = validateAndDecodePubkey(targetPubkey);
        if (!decodedTargetPubkey) {
            throw new ValidationError('Invalid target pubkey format. Must be hex, npub, or nprofile', 'targetPubkey');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        if (!effectiveSourcePubkey || typeof effectiveSourcePubkey !== 'string') {
            throw new ValidationError('Invalid source pubkey', 'sourcePubkey');
        }

        // Decode source pubkey from any supported format (hex, npub, nprofile)
        const decodedSourcePubkey = validateAndDecodePubkey(effectiveSourcePubkey);
        if (!decodedSourcePubkey) {
            throw new ValidationError('Invalid source pubkey format. Must be hex, npub, or nprofile', 'sourcePubkey');
        }

        try {
            const distance = await this.socialGraph.getDistance(decodedTargetPubkey);

            const metrics = await this.metricsValidator.validateAll(decodedTargetPubkey, decodedSourcePubkey);
            if (weightingScheme) {
                const weightProfileManager = this.metricsValidator.getWeightProfileManager();
                weightProfileManager.activateProfile(weightingScheme);
            }

            const trustScore = this.trustCalculator.calculate(
                decodedSourcePubkey, decodedTargetPubkey, metrics, distance
            );
            return trustScore;

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
            await this.schedulerService.stop();
            
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
}