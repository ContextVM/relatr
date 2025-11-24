import { fetchEventsForPubkeys, validateAndDecodePubkey } from '@/utils/utils.nostr';
import { RelayPool } from 'applesauce-relay';
import type { NostrEvent } from 'nostr-tools';
import { dirname } from 'path';
import { createWeightProfileManager, RelatrConfigSchema } from '../config';
import { DatabaseManager } from '../database/DatabaseManager';
import { MetadataRepository } from '../database/repositories/MetadataRepository';
import { MetricsRepository } from '../database/repositories/MetricsRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { PubkeyMetadataFetcher } from '../graph/PubkeyMetadataFetcher';
import { SocialGraph as RelatrSocialGraph } from '../graph/SocialGraph';
import { SocialGraphBuilder } from '../graph/SocialGraphBuilder';
import { TrustCalculator } from '../trust/TrustCalculator';
import type {
    CalculateTrustScoreParams,
    NostrProfile,
    RelatrConfig,
    SearchProfilesParams,
    SearchProfilesResult,
    StatsResult,
    TrustScore,
    WeightingScheme,
} from '../types';
import {
    RelatrError,
    SocialGraphError,
    ValidationError,
} from '../types';
import { MetricsValidator } from '../validators/MetricsValidator';
import { ALL_PLUGINS } from '../validators/plugins';
import { logger } from '../utils/Logger';

export class RelatrService {
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
    ];
    private config: RelatrConfig;
    private dbManager: DatabaseManager | null = null;
    private socialGraph: RelatrSocialGraph | null = null;
    private socialGraphBuilder: SocialGraphBuilder | null = null;
    private pubkeyMetadataFetcher: PubkeyMetadataFetcher | null = null;
    private trustCalculator: TrustCalculator | null = null;
    private metricsValidator: MetricsValidator | null = null;
    private metricsRepository: MetricsRepository | null = null;
    private metadataRepository: MetadataRepository | null = null;
    private settingsRepository: SettingsRepository | null = null;
    private pool: RelayPool | null = null;
    private initialized = false;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private syncInterval: NodeJS.Timeout | null = null;
    private validationInterval: NodeJS.Timeout | null = null;
    private discoveryQueue: Set<string> = new Set();
    
    constructor(config: RelatrConfig) {
        if (!config) throw new RelatrError('Configuration required', 'CONSTRUCTOR');
        
        const result = RelatrConfigSchema.safeParse(config);
        
        if (!result.success) {
            const errorMessages = result.error.errors.map(err =>
                `${err.path.join('.')}: ${err.message}`
            ).join(', ');
            throw new ValidationError(`Configuration validation failed: ${errorMessages}`, 'config');
        }
        
        this.config = result.data;
    }
    
    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            // Step 0: Ensure data directory exists with proper permissions
            await this.ensureDataDirectory();
            
            // Step 1: Initialize Database Manager
            this.dbManager = DatabaseManager.getInstance(this.config.databasePath);
            await this.dbManager.initialize();
            
            // Use a single shared connection for all components to reduce transaction conflicts
            // The retry logic in repositories will handle any conflicts that occur
            const sharedConnection = this.dbManager.getConnection();
            
            // Step 2: Initialize Repositories
            this.metricsRepository = new MetricsRepository(sharedConnection, this.config.cacheTtlSeconds);
            this.metadataRepository = new MetadataRepository(sharedConnection);
            this.settingsRepository = new SettingsRepository(sharedConnection);
            
            // Step 3: Initialize network components and builders first
            this.pool = new RelayPool();
            this.socialGraphBuilder = new SocialGraphBuilder(this.config, this.pool);
            this.pubkeyMetadataFetcher = new PubkeyMetadataFetcher(this.pool, this.metadataRepository);

            // Step 4: Check if social graph exists and handle first-time setup
            let graphExists = false;
            try {
                const result = await sharedConnection.run("SELECT 1 FROM nsd_follows LIMIT 1");
                graphExists = true;
            } catch (e) {
                graphExists = false;
            }
            
            if (!graphExists) {
                logger.info('🆕 Social graph tables not found in database. Creating new graph...');
                
                await this.socialGraphBuilder.createGraph({
                    sourcePubkey: this.config.defaultSourcePubkey,
                    hops: this.config.numberOfHops,
                    connection: sharedConnection
                });
                
                logger.info('✅ Social graph created successfully.');
            }
            
            // Step 5: Initialize the social graph with the shared connection
            this.socialGraph = new RelatrSocialGraph(sharedConnection);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            const graphStats = await this.socialGraph.getStats()
            logger.info('Social graph stats', graphStats);
            
            // Step 6: Initialize trust calculation components
            const weightProfileManager = createWeightProfileManager();
            this.trustCalculator = new TrustCalculator(this.config, weightProfileManager);
            this.metricsValidator = new MetricsValidator(this.pool, this.config.nostrRelays, this.socialGraph, this.metricsRepository, this.metadataRepository, this.config.cacheTtlSeconds, ALL_PLUGINS, weightProfileManager);
            
            this.initialized = true;
            
            // Step 7: If this is the first time running, fetch initial metadata
            if (!graphExists && (await this.metadataRepository.getStats()).totalEntries === 0) {
                logger.info('👤 Fetching initial profile metadata...');
                const keys = Object.keys(graphStats.sizeByDistance);
                const maxDistance = keys.length ? Math.max(...keys.map(Number)) : null;
                const pubkeys = await this.socialGraph.getAllUsersInGraph();
                logger.info(`📊 Found ${pubkeys.length.toLocaleString()} pubkeys within ${maxDistance || this.config.numberOfHops} hops for metadata fetching`);
                await this.pubkeyMetadataFetcher.fetchMetadata({
                    pubkeys,
                    sourcePubkey: this.config.defaultSourcePubkey
                });
            }
            
            this.syncValidations();
            
            // Step 8: Start background processes
            this.startBackgroundCleanup();
            this.startPeriodicSync();
            this.startPeriodicValidationSync();
            logger.info('Background processes started');
            
        } catch (error) {
            await this.cleanup();
            throw new RelatrError(`Init failed: ${error instanceof Error ? error.message : String(error)}`, 'INITIALIZE');
        }
    }
    
    // Static constants
    private static readonly FIELD_WEIGHTS = {
        name: 0.5,
        display_name: 0.35,
        nip05: 0.1,
    };

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
            const distance = await this.socialGraph!.getDistance(decodedTargetPubkey);

            const metrics = await this.metricsValidator!.validateAll(decodedTargetPubkey, decodedSourcePubkey);
            if (weightingScheme) {
                const weightProfileManager = this.metricsValidator!.getWeightProfileManager();
                weightProfileManager.activateProfile(weightingScheme);
            }

            const trustScore = this.trustCalculator!.calculate(
                decodedSourcePubkey, decodedTargetPubkey, metrics, distance
            );
            return trustScore;

        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError ||
                error instanceof SocialGraphError) {
                throw error;
            }
            throw new RelatrError(`Calc failed: ${error instanceof Error ? error.message : String(error)}`, 'CALCULATE');
        }
    }

    private async calculateProfileScores(
        profiles: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[],
        effectiveSourcePubkey: string,
        weightingScheme?: WeightingScheme
    ): Promise<{ pubkey: string; trustScore: number; exactMatch: boolean }[]> {
        if (profiles.length === 0) {
            return [];
        }

        const startTime = Date.now();

        try {
            // Extract pubkeys for batch operations
            const profilePubkeys = profiles.map(p => p.pubkey);

            // Pre-fetch all distances and metrics in parallel
            const [distances, metricsMap] = await Promise.all([
                this.socialGraph!.getDistancesBatch(profilePubkeys),
                this.metricsValidator!.validateAllBatch(
                    profilePubkeys,
                    effectiveSourcePubkey
                )
            ]);

            // Apply weighting scheme if specified
            if (weightingScheme) {
                const weightProfileManager = this.metricsValidator!.getWeightProfileManager();
                weightProfileManager.activateProfile(weightingScheme);
            }

            // Calculate trust scores with pre-fetched data
            const results = profiles.map(({ pubkey, relevanceMultiplier, isExactMatch }) => {
                try {
                    const distance = distances.get(pubkey) || 1000;
                    const metrics = metricsMap.get(pubkey);

                    if (!metrics) {
                        return {
                            pubkey,
                            rawScore: 0,
                            exactMatch: isExactMatch
                        };
                    }

                    const trustScore = this.trustCalculator!.calculate(
                        effectiveSourcePubkey,
                        pubkey,
                        metrics,
                        distance
                    );

                    let finalRelevanceMultiplier = relevanceMultiplier;
                    if (isExactMatch) {
                        finalRelevanceMultiplier *= 1.15;
                    }

                    const rawCombinedScore = trustScore.score * finalRelevanceMultiplier;

                    return {
                        pubkey,
                        rawScore: rawCombinedScore,
                        exactMatch: isExactMatch
                    };
                } catch (error) {
                    logger.warn(`Failed to calculate trust score for ${pubkey}:`, error instanceof Error ? error.message : String(error));
                    return {
                        pubkey,
                        rawScore: 0,
                        exactMatch: isExactMatch
                    };
                }
            });

            // Single normalization point - normalize all scores to 0-1 range
            const maxRawScore = Math.max(...results.map(r => r.rawScore), 1.0);

            const endTime = Date.now();

            return results.map(result => ({
                pubkey: result.pubkey,
                trustScore: result.rawScore / maxRawScore,
                exactMatch: result.exactMatch
            }));

        } catch (error) {
            logger.warn(`Batch scoring failed, falling back to individual scoring:`, error instanceof Error ? error.message : String(error));
            // Fall back to the original sequential method if batch fails
            return this.calculateProfileScores(profiles, effectiveSourcePubkey, weightingScheme);
        }
    }

    private calculateRelevanceMultiplier(profile: NostrProfile, query: string): { multiplier: number; isExactMatch: boolean } {
        const queryLower = query.toLowerCase();
        let relevanceScore = 0;
        let isExactMatch = false;

        for (const [field, weight] of Object.entries(RelatrService.FIELD_WEIGHTS)) {
            const fieldValue = profile[field as keyof NostrProfile];
            if (typeof fieldValue === 'string' && fieldValue.trim()) {
                const valueLower = fieldValue.toLowerCase();
                
                // Only count as exact match if the ENTIRE field equals the query
                if (valueLower === queryLower) {
                    relevanceScore += weight;
                    if (field === 'name' || field === 'display_name') {
                        isExactMatch = true;
                    }
                } else if (valueLower.startsWith(queryLower)) {
                    relevanceScore += weight * 0.85;
                } else if (valueLower.includes(queryLower)) {
                    relevanceScore += weight * 0.55;
                } else if (new RegExp(`\\b${queryLower}\\b`, 'i').test(fieldValue)) {
                    relevanceScore += weight * 0.35;
                }
            }
        }

        const normalizedRelevanceScore = Math.min(1, relevanceScore);
        const maxMultiplier = 1.4;
        let relevanceMultiplier = 1.0 + (normalizedRelevanceScore * (maxMultiplier - 1.0));

        return {
            multiplier: relevanceMultiplier,
            isExactMatch
        };
    }

    /**
     * Search profiles with distance-aware relevance scoring
     * Database returns pre-ranked results based on text match + social distance
     * Trust scores calculated only for top candidates for performance
     */
    async searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        if (!this.metadataRepository) throw new RelatrError('Metadata repository not initialized', 'DATABASE_NOT_INITIALIZED');
        
        const { query, limit = 5, sourcePubkey, weightingScheme, extendToNostr } = params;

        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }

        const effectiveSourcePubkey = sourcePubkey || this.socialGraph?.getCurrentRoot() || this.config.defaultSourcePubkey;
        const startTime = Date.now();

        // Search local database - returns top N results ranked by text relevance + root distance
        const localResults = await this.metadataRepository.search(query, limit, this.config.decayFactor);
        
        logger.debug(`🔍 Found ${localResults.length} distance-ranked profiles from database`);

        // Prepare profiles for trust scoring
        const profilesForScoring = localResults.map((r) => ({
            pubkey: r.pubkey,
            relevanceMultiplier: r.score,
            isExactMatch: r.isExactMatch
        }));

        // Extend to Nostr if needed
        const nostrProfiles = await this.extendSearchWithNostr(query, limit, profilesForScoring, extendToNostr);

        // Process and return final results
        return this.processSearchResults(
            [...profilesForScoring, ...nostrProfiles],
            nostrProfiles,
            effectiveSourcePubkey,
            weightingScheme,
            limit,
            startTime
        );
    }

    /**
     * Extend search to Nostr relays for additional results
     */
    private async extendSearchWithNostr(
        query: string,
        limit: number,
        profilesForScoring: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[],
        extendToNostr?: boolean
    ): Promise<{ pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[]> {
        const nostrProfiles: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[] = [];
        const shouldExtendToNostr = extendToNostr || profilesForScoring.length === 0;
        
        if (!shouldExtendToNostr || !this.pool) {
            return nostrProfiles;
        }

        const remaining = Math.max(0, limit - profilesForScoring.length);
        if (remaining <= 0) {
            return nostrProfiles;
        }

        logger.debug(`🔍 Extending search to Nostr relays for up to ${remaining} results`);

        const searchFilter = { kinds: [0], search: query, limit: remaining };

        try {
            const nostrEvents = await new Promise<NostrEvent[]>((resolve, reject) => {
                const events: NostrEvent[] = [];
                const subscription = this.pool!.request(
                    RelatrService.SEARCH_RELAYS,
                    searchFilter,
                    { retries: 1 }
                ).subscribe({
                    next: (event) => events.push(event),
                    error: (error) => reject(error),
                    complete: () => resolve(events)
                });

                setTimeout(() => {
                    subscription.unsubscribe();
                    resolve(events);
                }, 5000);
            });

            for (const event of nostrEvents) {
                const existingPubkey = profilesForScoring.find(p => p.pubkey === event.pubkey);
                if (!existingPubkey && !nostrProfiles.find(p => p.pubkey === event.pubkey)) {
                    const profile = JSON.parse(event.content);
                    const { multiplier, isExactMatch } = this.calculateRelevanceMultiplier(profile, query);
                    nostrProfiles.push({
                        pubkey: event.pubkey,
                        relevanceMultiplier: multiplier,
                        isExactMatch
                    });
                    this.metadataRepository!.save({ pubkey: event.pubkey, ...profile }).catch(err => {
                        logger.warn(`Failed to cache profile for ${event.pubkey}:`, err);
                    });
                }
            }
        } catch {
            // Remote search failed, continue with local results only
            logger.debug('Nostr relay search failed, continuing with local results only');
        }

        return nostrProfiles;
    }

    /**
     * Process search results by calculating trust scores and formatting output
     */
    private async processSearchResults(
        finalProfiles: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[],
        nostrProfiles: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[],
        effectiveSourcePubkey: string,
        weightingScheme: WeightingScheme | undefined,
        limit: number,
        startTime: number
    ): Promise<SearchProfilesResult> {
        const profilesWithScores = await this.calculateProfileScores(
            finalProfiles,
            effectiveSourcePubkey,
            weightingScheme
        );

        // Queue high-scoring Nostr profiles for discovery
        this.queueProfilesForDiscovery(profilesWithScores, nostrProfiles);

        // Sort by trust score and return top results
        profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

        const results = profilesWithScores.slice(0, limit).map((item, index) => ({
            pubkey: item.pubkey,
            trustScore: item.trustScore,
            rank: index + 1,
            exactMatch: item.exactMatch
        }));

        const endTime = Date.now();
        logger.info(`Search completed in ${endTime - startTime}ms`);

        return {
            results,
            totalFound: results.length,
            searchTimeMs: endTime - startTime
        };
    }

    /**
     * Queue high-scoring Nostr profiles for contact discovery
     */
    private queueProfilesForDiscovery(
        profilesWithScores: { pubkey: string; trustScore: number; exactMatch: boolean }[],
        nostrProfiles: { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[]
    ): void {
        profilesWithScores.forEach(profile => {
            if (profile.trustScore > 0.5 && nostrProfiles.find(p => p.pubkey === profile.pubkey)) {
                this.discoveryQueue.add(profile.pubkey);
                logger.debug(`📥 Queued ${profile.pubkey} for contact discovery`);
            }
        });
    }


    async getStats(): Promise<StatsResult> {
        const timestamp = Math.floor(Date.now() / 1000);

        try {
            // Get database stats
            let metricsTotalEntries = 0;
            let metadataTotalEntries = 0;

            if (this.metricsRepository) {
                const metricsStats = await this.metricsRepository.getStats();
                metricsTotalEntries = metricsStats.totalEntries;
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
                    metrics: { totalEntries: metricsTotalEntries },
                    metadata: { totalEntries: metadataTotalEntries }
                },
                socialGraph: {
                    stats: socialGraphStats,
                    rootPubkey
                }
            };
        } catch (error) {
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
        if (this.socialGraph) {
            await this.socialGraph.cleanup();
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        if (this.validationInterval) {
            clearInterval(this.validationInterval);
            this.validationInterval = null;
        }
        if (this.dbManager) await this.dbManager.close();

        this.dbManager = null;
        this.socialGraph = null;
        this.trustCalculator = null;
        this.metricsValidator = null;
        this.metricsRepository = null;
        this.metadataRepository = null;
        this.settingsRepository = null;
        this.pool = null;
        this.initialized = false;
    }

    /**
     * Start background cache cleanup process
     * @private
     */
    private startBackgroundCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        this.cleanupInterval = setInterval(async () => {
            try {
                if (this.metricsRepository && this.initialized) {
                    const deleted = await this.metricsRepository.cleanup();
                    // Only log if entries were actually deleted
                    if (deleted > 0) {
                        logger.info(`Background cleanup completed: ${deleted} expired entries removed`);
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                logger.error('Background cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }, this.config.cleanupInterval);
    }

    /**
     * Sync Nostr profiles and update trust metrics
     * @param force Force sync even if recent
     * @param hops Number of hops to sync (default: 1)
     * @param sourcePubkey Source pubkey to sync from
     */
    async syncProfiles(force: boolean = false, hops: number = 1, sourcePubkey?: string): Promise<void> {
        logger.info('Starting profile sync and metrics pre-caching...');
        if (!this.pool || !this.dbManager || !this.metricsValidator || !this.socialGraph || !this.metadataRepository || !this.pubkeyMetadataFetcher || !this.settingsRepository) {
            throw new RelatrError('Service not properly initialized', 'NOT_INITIALIZED');
        }
        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const syncKey = `contact_sync:${effectiveSourcePubkey}`;
        logger.info(`Syncing profiles for ${hops} hops from ${effectiveSourcePubkey}`);
        try {
            // Check last sync time unless forced
            if (!force) {
                const lastSyncTimeStr = await this.settingsRepository.get(syncKey);

                if (lastSyncTimeStr) {
                    const lastSyncTime = parseInt(lastSyncTimeStr);
                    if (Date.now() - lastSyncTime < this.config.syncInterval) {
                        logger.info(`Skipping contact sync - last sync was recent.`);
                        return;
                    }
                }
            }

            logger.info('Starting profile sync and metrics pre-caching...');
            // Step 1: Get all pubkeys from the social graph
            const discoveredPubkeys = await this.socialGraph.getAllUsersInGraph();
            
            // Step 2: Fetch metadata for ALL pubkeys to ensure we have the latest metadata            logger.info(`📊 Fetching metadata for ${discoveredPubkeys.length.toLocaleString()} pubkeys`);
            
            await this.pubkeyMetadataFetcher.fetchMetadata({
                pubkeys: discoveredPubkeys,
                sourcePubkey: effectiveSourcePubkey
            });

            const now = Date.now();
            await this.settingsRepository.set(syncKey, now.toString());

            logger.info(`Sync completed in ${Date.now() - startTime}ms`);

        } catch (error) {
            logger.error('Profile sync error:', error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    /**
     * Process the discovery queue by fetching contact events and integrating into graph
     * @private
     */
    private async processDiscoveryQueue(): Promise<void> {
        if (this.discoveryQueue.size === 0) return;
        
        console.log(`[RelatrService] 🔄 Processing discovery queue with ${this.discoveryQueue.size} pubkeys...`);
        const startTime = Date.now();
        
        try {
            const pubkeysToProcess = Array.from(this.discoveryQueue);
            this.discoveryQueue.clear(); // Clear queue immediately to avoid reprocessing
            
            // Fetch contact events for queued pubkeys
            const contactEvents = await fetchEventsForPubkeys(
                pubkeysToProcess,
                3, // kind 3 = contact lists
                undefined,
                this.pool!,
                undefined
            );
            
            console.log(`[RelatrService] 📥 Fetched ${contactEvents.length} contact events for ${pubkeysToProcess.length} pubkeys`);
            
            // Process contact events to integrate into graph
            if (contactEvents.length > 0 && this.socialGraph) {
                await this.socialGraph.processContactEvents(contactEvents);
                console.log(`[RelatrService] ✅ Integrated ${contactEvents.length} contact events into social graph`);
            }
            
            console.log(`[RelatrService] Discovery queue processing completed in ${Date.now() - startTime}ms`);
        } catch (error) {
            console.error('[RelatrService] Discovery queue processing failed:', error instanceof Error ? error.message : String(error));
            // Don't throw - this is background processing and shouldn't break the main flow
        }
    }

    /**
     * Sync validation metrics for pubkeys missing validation scores
     * @param batchSize - Number of validations to process in each batch (default: 50)
     * @param sourcePubkey - Source pubkey for reciprocity validation (optional)
     */
    async syncValidations(batchSize: number = 250, sourcePubkey?: string): Promise<void> {
        logger.info('Starting validation sync...');
        if (!this.socialGraph || !this.metricsValidator || !this.metricsRepository) {
            throw new RelatrError('Service not properly initialized for validation sync', 'NOT_INITIALIZED');
        }

        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;

        try {
            // Step 1: Get all pubkeys from the social graph
            const allPubkeys = await this.socialGraph.getAllUsersInGraph();
            logger.info(`📊 Found ${allPubkeys.length.toLocaleString()} pubkeys in social graph`);

            // Step 2: Identify pubkeys without validation scores
            const pubkeysWithoutScores = (await this.metricsRepository.getPubkeysWithoutScores(allPubkeys))
            logger.info(`🔍 Found ${pubkeysWithoutScores.length.toLocaleString()} pubkeys missing validation scores`);

            if (pubkeysWithoutScores.length === 0) {
                logger.info('✅ All pubkeys have validation scores, no sync needed');
                return;
            }

            // Step 3: Process validations in batches to avoid overwhelming the system
            let processedCount = 0;
            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < pubkeysWithoutScores.length; i += batchSize) {
                const batch = pubkeysWithoutScores.slice(i, i + batchSize);
                logger.info(`🔄 Processing validation batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(pubkeysWithoutScores.length / batchSize)} (${batch.length} pubkeys)`);

                const batchResults = await Promise.allSettled(
                    batch.map(pubkey =>
                        this.metricsValidator!.validateAll(pubkey, effectiveSourcePubkey)
                            .then(() => ({ pubkey, success: true }))
                            .catch(error => ({ pubkey, success: false, error }))
                    )
                );

                // Count successes and errors
                for (const result of batchResults) {
                    processedCount++;
                    if (result.status === 'fulfilled' && result.value.success) {
                        successCount++;
                    } else {
                        errorCount++;
                        if (result.status === 'fulfilled') {
                            const { pubkey, error } = result.value as { pubkey: string; success: boolean; error: any };
                            logger.warn(`⚠️ Validation failed for ${pubkey}:`, error instanceof Error ? error.message : String(error));
                        } else {
                            logger.warn(`⚠️ Validation failed for unknown pubkey:`, result.reason instanceof Error ? result.reason.message : String(result.reason));
                        }
                    }
                }

                // Log progress
                logger.info(`📈 Progress: ${processedCount}/${pubkeysWithoutScores.length} processed, ${successCount} successful, ${errorCount} failed`);
            }

            logger.info(`✅ Validation sync completed in ${Date.now() - startTime}ms. Processed: ${processedCount}, Successful: ${successCount}, Failed: ${errorCount}`);

        } catch (error) {
            logger.error('Validation sync error:', error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    /**
     * Start periodic background sync
     * @private
     */
    private startPeriodicSync(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }

        this.syncInterval = setInterval(async () => {
            try {
                if (this.initialized) {
                    logger.info('Starting periodic background sync...');
                    await this.syncProfiles(false, 1);
                    logger.info('Periodic sync completed');
                }
            } catch (error) {
                // Log error but don't crash the service
                logger.error('Periodic sync failed:', error instanceof Error ? error.message : String(error));
            }
        }, this.config.syncInterval);
    }

    /**
     * Start periodic validation sync
     * @private
     */
    private startPeriodicValidationSync(): void {
        if (this.validationInterval) {
            clearInterval(this.validationInterval);
        }

        this.validationInterval = setInterval(async () => {
            try {
                if (this.initialized) {
                    logger.info('Starting periodic validation sync...');
                    await this.syncValidations();
                    logger.info('Periodic validation sync completed');
                    if (this.discoveryQueue.size > 0 && this.socialGraph) {
                        await this.processDiscoveryQueue();
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                logger.error('Periodic validation sync failed:', error instanceof Error ? error.message : String(error));
            }
        }, this.config.validationSyncInterval);
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): RelatrSocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }

    /**
     * Ensure data directory exists with proper permissions
     * @private
     */
    private async ensureDataDirectory(): Promise<void> {
        try {
            // Extract data directory from database path (default: ./data/relatr.db)
            const dataDir = this.extractDataDirectory(this.config.databasePath);

            // Check if directory exists
            let dirExists = false;
            try {
                await Bun.$`stat ${dataDir}`;
                dirExists = true;
            } catch {
                dirExists = false;
            }

            if (!dirExists) {
                logger.info(`📁 Creating data directory: ${dataDir}`);

                // Create directory recursively
                await Bun.$`mkdir -p ${dataDir}`;

                logger.info(`✅ Data directory created`);
            } else {
                // Check if directory is writable by current user
                try {
                    // Try to create a test file to check write permissions
                    const testFile = `${dataDir}/.write_test_${Date.now()}`;
                    await Bun.write(testFile, "test");
                    await Bun.$`rm ${testFile}`;
                } catch (writeError) {
                    const effectiveUid = typeof process.getuid === "function" ? process.getuid() : null;
                    const effectiveGid = typeof process.getgid === "function" ? process.getgid() : null;

                    throw new RelatrError(
                        `Data directory exists but is not writable by current user (uid=${effectiveUid} gid=${effectiveGid}). ` +
                        `Please ensure the data directory has proper permissions or remove it to let the application create it.`,
                        'DATA_DIRECTORY_PERMISSIONS'
                    );
                }
            }
        } catch (error) {
            if (error instanceof RelatrError) {
                throw error;
            }
            throw new RelatrError(
                `Failed to ensure data directory: ${error instanceof Error ? error.message : String(error)}`,
                'DATA_DIRECTORY'
            );
        }
    }

    /**
     * Extract data directory path from file path
     * @private
     */
    private extractDataDirectory(filePath: string): string {
        return dirname(filePath);
    }
}
