import type {
    RelatrConfig,
    CalculateTrustScoreParams,
    TrustScore,
    HealthCheckResult,
    ManageCacheResult,
    MetricWeights,
    ProfileMetrics,
    SearchProfilesParams,
    SearchProfilesResult,
    SearchProfileResult,
    NostrProfile,
    WeightingScheme
} from '../types';
import { 
    RelatrError, 
    DatabaseError, 
    SocialGraphError, 
    ValidationError,
    CacheError 
} from '../types';
import { SimplePool } from 'nostr-tools/pool';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, cleanupExpiredCache, isDatabaseHealthy } from '../database/connection';
import { SimpleCache } from '../database/cache';
import { SocialGraph } from '../graph/SocialGraph';
import { TrustCalculator } from '../trust/TrustCalculator';
import { MetricsValidator } from '../validators/MetricsValidator';
import { getWeightingPreset } from '../config';
import { withTimeout } from '@/utils';

export class RelatrService {
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
        'wss://nos.lol'
    ];

    private config: RelatrConfig;
    private db: Database | null = null;
    private socialGraph: SocialGraph | null = null;
    private trustCalculator: TrustCalculator | null = null;
    private metricsValidator: MetricsValidator | null = null;
    private metricsCache: SimpleCache<ProfileMetrics> | null = null;
    private metadataCache: SimpleCache<NostrProfile> | null = null;
    private searchCache: SimpleCache<string[]> | null = null; // Store array of pubkeys
    private searchPool: SimplePool | null = null;
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
            // Pass the database instance to cache constructor for consistency
            this.metricsCache = new SimpleCache(this.db, 'profile_metrics', this.config.cacheTtlSeconds);
            this.metadataCache = new SimpleCache(this.db, 'pubkey_metadata', 3600); // 1 hour TTL for metadata
            this.searchCache = new SimpleCache(this.db, 'search_results', 300); // 5 minutes TTL for search results
            this.socialGraph = new SocialGraph(this.config.graphBinaryPath);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            this.trustCalculator = new TrustCalculator(this.config);
            this.metricsValidator = new MetricsValidator(this.config.nostrRelays, this.socialGraph, this.metricsCache);
            this.searchPool = new SimplePool();
            this.initialized = true;
        } catch (error) {
            await this.cleanup();
            throw new RelatrError(`Init failed: ${error instanceof Error ? error.message : String(error)}`, 'INITIALIZE');
        }
    }

    async calculateTrustScore(params: CalculateTrustScoreParams): Promise<TrustScore> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');

        const { sourcePubkey, targetPubkey, weightingScheme } = params;
        
        if (!targetPubkey || typeof targetPubkey !== 'string') {
            throw new ValidationError('Invalid target pubkey', 'targetPubkey');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        if (!effectiveSourcePubkey || typeof effectiveSourcePubkey !== 'string') {
            throw new ValidationError('Invalid source pubkey', 'sourcePubkey');
        }

        try {
            const distance = effectiveSourcePubkey !== this.socialGraph!.getCurrentRoot()
                ? await this.socialGraph!.getDistanceBetween(effectiveSourcePubkey, targetPubkey)
                : this.socialGraph!.getDistance(targetPubkey);

            const metrics = await this.metricsValidator!.validateAll(targetPubkey, effectiveSourcePubkey);
            const weights = weightingScheme ? getWeightingPreset(weightingScheme) : this.config.weights;

            const trustScore = this.trustCalculator!.calculate(
                effectiveSourcePubkey, targetPubkey, metrics, distance, weights
            );
            return trustScore;

        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError || 
                error instanceof SocialGraphError || error instanceof CacheError) {
                throw error;
            }
            throw new RelatrError(`Calc failed: ${error instanceof Error ? error.message : String(error)}`, 'CALCULATE');
        }
    }

    /**
     * Helper method to sanitize profile by removing null values
     * @private
     */
    private sanitizeProfile(profile: NostrProfile): NostrProfile {
        const sanitized: NostrProfile = { pubkey: profile.pubkey };
        
        // Only include non-null, non-undefined string values
        if (profile.name) sanitized.name = profile.name;
        if (profile.display_name) sanitized.display_name = profile.display_name;
        if (profile.picture) sanitized.picture = profile.picture;
        if (profile.nip05) sanitized.nip05 = profile.nip05;
        if (profile.lud16) sanitized.lud16 = profile.lud16;
        if (profile.about) sanitized.about = profile.about;
        
        return sanitized;
    }

    /**
     * Helper method to calculate trust scores for profiles
     * @private
     */
    private async calculateProfileScores(
        pubkeys: string[],
        effectiveSourcePubkey: string,
        weightingScheme?: WeightingScheme
    ): Promise<{ pubkey: string; profile: NostrProfile; trustScore: number }[]> {
        return Promise.all(
            pubkeys.map(async (pubkey) => {
                try {
                    // Try to get profile from metadata cache
                    let profile = await this.metadataCache!.get(pubkey);
                    
                    // If not in cache, create minimal profile
                    if (!profile) {
                        profile = { pubkey };
                    }
                    
                    // Sanitize profile to remove null values
                    const sanitizedProfile = this.sanitizeProfile(profile);
                    
                    const trustScore = await this.calculateTrustScore({
                        sourcePubkey: effectiveSourcePubkey,
                        targetPubkey: pubkey,
                        weightingScheme
                    });
                    
                    return {
                        pubkey,
                        profile: sanitizedProfile,
                        trustScore: trustScore.score
                    };
                } catch (error) {
                    // Assign score 0 on error but include in results
                    return {
                        pubkey,
                        profile: { pubkey },
                        trustScore: 0
                    };
                }
            })
        );
    }

    async searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');

        const { query, limit = 7, sourcePubkey, weightingScheme } = params;
        
        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();
        
        // Normalize query for better cache hit rate
        const normalizedQuery = query.trim().toLowerCase();
        const cacheKey = `search:${normalizedQuery}:${effectiveSourcePubkey}:${weightingScheme || 'default'}`;
        
        // Check search cache first
        try {
            const cachedPubkeys = await this.searchCache!.get(cacheKey);
            if (cachedPubkeys && cachedPubkeys.length > 0) {
                // Reconstruct results from metadata cache
                const profilesWithScores = await this.calculateProfileScores(
                    cachedPubkeys,
                    effectiveSourcePubkey,
                    weightingScheme
                );

                // Sort by trust score (descending)
                profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

                // Add rank and create final results
                const results: SearchProfileResult[] = profilesWithScores.map((item, index) => ({
                    pubkey: item.pubkey,
                    profile: item.profile,
                    trustScore: item.trustScore,
                    rank: index + 1
                }));

                return {
                    results,
                    totalFound: cachedPubkeys.length,
                    searchTimeMs: Date.now() - startTime
                };
            }
        } catch (error) {
            // Cache miss - continue with search
        }

        try {
            // Query search relays with kind 0 filter + search param
            const searchFilter = {
                kinds: [0],
                search: query, // Use original query for search relays
                limit: limit
            };

            const events = await withTimeout(
                this.searchPool!.querySync(RelatrService.SEARCH_RELAYS, searchFilter),
                10000 // 10 second timeout
            ) as any[];

            // Extract unique pubkeys and parse profiles
            const pubkeyMap = new Map<string, NostrProfile>();
            const pubkeys: string[] = [];
            
            for (const event of events) {
                if (!pubkeyMap.has(event.pubkey)) {
                    try {
                        const profile = JSON.parse(event.content) as Partial<NostrProfile>;
                        const fullProfile: NostrProfile = {
                            pubkey: event.pubkey,
                            name: profile.name,
                            display_name: profile.display_name,
                            picture: profile.picture,
                            nip05: profile.nip05,
                            lud16: profile.lud16,
                            about: profile.about,
                        };
                        
                        pubkeyMap.set(event.pubkey, fullProfile);
                        pubkeys.push(event.pubkey);
                        
                        // Cache the metadata
                        try {
                            await this.metadataCache!.set(event.pubkey, fullProfile);
                        } catch (error) {
                            // Metadata cache failed - continue
                        }
                    } catch (error) {
                        // Skip invalid profile content but still include pubkey
                        const minimalProfile: NostrProfile = { pubkey: event.pubkey };
                        pubkeyMap.set(event.pubkey, minimalProfile);
                        pubkeys.push(event.pubkey);
                    }
                }
            }

            // Calculate trust scores in parallel - sanitize profiles to remove nulls
            const profilesWithScores = await Promise.all(
                Array.from(pubkeyMap.entries()).map(async ([pubkey, profile]) => {
                    try {
                        const trustScore = await this.calculateTrustScore({
                            sourcePubkey: effectiveSourcePubkey,
                            targetPubkey: pubkey,
                            weightingScheme
                        });
                        return {
                            pubkey,
                            profile: this.sanitizeProfile(profile),
                            trustScore: trustScore.score
                        };
                    } catch (error) {
                        return {
                            pubkey,
                            profile: this.sanitizeProfile(profile),
                            trustScore: 0
                        };
                    }
                })
            );

            // Sort by trust score (descending)
            profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

            // Add rank and create final results
            const results: SearchProfileResult[] = profilesWithScores.map((item, index) => ({
                pubkey: item.pubkey,
                profile: item.profile,
                trustScore: item.trustScore,
                rank: index + 1
            }));

            const searchTimeMs = Date.now() - startTime;

            const searchResult: SearchProfilesResult = {
                results,
                totalFound: events.length,
                searchTimeMs
            };

            // Cache the pubkeys for this search
            try {
                await this.searchCache!.set(cacheKey, pubkeys);
            } catch (error) {
                // Cache set failed - continue and return results
            }

            return searchResult;

        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError) {
                throw error;
            }
            throw new RelatrError(`Search failed: ${error instanceof Error ? error.message : String(error)}`, 'SEARCH');
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
                    
                    return {
                        success: true,
                        metricsCleared,
                        message: targetPubkey ? `Cleared ${targetPubkey}` : 'Cleared all'
                    };
                }
                case 'cleanup': {
                    const metricsDeleted = await this.metricsCache!.cleanup();
                    return {
                        success: true,
                        metricsCleared: metricsDeleted,
                        message: `Cleaned ${metricsDeleted} metrics`
                    };
                }
                case 'stats': {
                    const metricsStats = await this.metricsCache!.getStats();

                    return {
                        success: true,
                        message: `Metrics: ${metricsStats.totalEntries}/${metricsStats.expiredEntries}`
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
        if (this.searchPool) {
            this.searchPool.close(RelatrService.SEARCH_RELAYS);
        }
        if (this.db) closeDatabase(this.db);
        
        this.db = null;
        this.socialGraph = null;
        this.trustCalculator = null;
        this.metricsValidator = null;
        this.metricsCache = null;
        this.metadataCache = null;
        this.searchCache = null;
        this.searchPool = null;
        this.initialized = false;
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): SocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }
}