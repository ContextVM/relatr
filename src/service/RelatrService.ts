import { DataStore } from '@/database/data-store';
import { sanitizeProfile } from '@/utils/utils';
import { fetchEventsForPubkeys, validateAndDecodePubkey } from '@/utils/utils.nostr';
import { RelayPool } from 'applesauce-relay';
import { DuckDBConnection } from '@duckdb/node-api';
import type { NostrEvent } from 'nostr-tools';
import { dirname } from 'path';
import { createWeightProfileManager, RelatrConfigSchema } from '../config';
import { initDuckDB, closeDuckDB, cleanupExpiredDuckDBCache } from '../database/duckdb-connection';
import { PubkeyMetadataFetcher } from '../graph/PubkeyMetadataFetcher';
import { SocialGraph as RelatrSocialGraph } from '../graph/SocialGraph';
import { SocialGraphBuilder } from '../graph/SocialGraphBuilder';
import { TrustCalculator } from '../trust/TrustCalculator';
import type {
    CalculateTrustScoreParams,
    NostrProfile,
    ProfileMetrics,
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

export class RelatrService {
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
    ];
    private config: RelatrConfig;
    private db: DuckDBConnection | null = null;
    private socialGraph: RelatrSocialGraph | null = null;
    private socialGraphBuilder: SocialGraphBuilder | null = null;
    private pubkeyMetadataFetcher: PubkeyMetadataFetcher | null = null;
    private trustCalculator: TrustCalculator | null = null;
    private metricsValidator: MetricsValidator | null = null;
    private metricsStore: DataStore<ProfileMetrics> | null = null;
    private metadataStore: DataStore<NostrProfile> | null = null;
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

            // Step 1: Initialize DuckDB database and caches
            this.db = await initDuckDB(this.config.databasePath);
            this.metricsStore = new DataStore(this.db, 'profile_metrics', this.config.cacheTtlSeconds);
            this.metadataStore = new DataStore(this.db, 'pubkey_metadata');

            // Step 2: Initialize network components and builders first
            this.pool = new RelayPool();
            this.socialGraphBuilder = new SocialGraphBuilder(this.config, this.pool);
            this.pubkeyMetadataFetcher = new PubkeyMetadataFetcher(this.pool,this.metadataStore );

            // Step 3: Check if social graph exists and handle first-time setup
            // We check if the graph tables exist in the shared database
            let graphExists = false;
            try {
                const result = await this.db.run("SELECT 1 FROM nsd_follows LIMIT 1");
                graphExists = true;
            } catch (e) {
                graphExists = false;
            }

            if (!graphExists) {
                console.log(`[RelatrService] 🆕 Social graph tables not found in database. Creating new graph...`);

                await this.socialGraphBuilder.createGraph({
                    sourcePubkey: this.config.defaultSourcePubkey,
                    hops: this.config.numberOfHops,
                    connection: this.db
                });

                console.log('[RelatrService] ✅ Social graph created successfully.');
            }

            // Step 4: Initialize the social graph with shared DuckDB connection
            this.socialGraph = new RelatrSocialGraph(this.db);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            const graphStats = await this.socialGraph.getStats()
            console.log('[RelatrService] Social graph stats', graphStats);
            
            // Step 5: Initialize trust calculation components
            const weightProfileManager = createWeightProfileManager();
            this.trustCalculator = new TrustCalculator(this.config, weightProfileManager);
            this.metricsValidator = new MetricsValidator(this.pool, this.config.nostrRelays, this.socialGraph, this.metricsStore, undefined, weightProfileManager);

            this.initialized = true;

            // Step 6: If this is the first time running, fetch initial metadata
            if (!graphExists && (await this.metadataStore.getStats()).totalEntries === 0) {
                console.log('[RelatrService] 👤 Fetching initial profile metadata...');
                const keys = Object.keys(graphStats.sizeByDistance);
                const maxDistance = keys.length ? Math.max(...keys.map(Number)) : null;
                const pubkeys = await this.socialGraph.getAllUsersInGraph();
                console.log(`[RelatrService] 📊 Found ${pubkeys.length.toLocaleString()} pubkeys within ${maxDistance || this.config.numberOfHops} hops for metadata fetching`);
                await this.pubkeyMetadataFetcher.fetchMetadata({
                    pubkeys,
                    sourcePubkey: this.config.defaultSourcePubkey
                });
            }
            
            this.syncValidations();
            
            // Step 7: Start background processes
            this.startBackgroundCleanup();
            this.startPeriodicSync();
            this.startPeriodicValidationSync();
            console.log('[RelatrService] Background processes started');

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
            const distance = decodedSourcePubkey !== this.socialGraph!.getCurrentRoot()
                ? await this.socialGraph!.getDistanceBetween(decodedSourcePubkey, decodedTargetPubkey)
                : await this.socialGraph!.getDistance(decodedTargetPubkey);

            // Return a trust score of 0 if the target pubkey is far in distance
            // This avoids expensive validateAll calls for distant profiles, making search faster
            if (distance > 3) {
                return {
                    score: 0,
                    sourcePubkey: decodedSourcePubkey,
                    targetPubkey: decodedTargetPubkey,
                    components: {
                        distanceWeight: 0,
                        validators: {},
                        socialDistance: distance,
                        normalizedDistance: 0
                    },
                    computedAt: Date.now()
                };
            }

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
        profiles: { pubkey: string; profile: NostrProfile; relevanceMultiplier: number; isExactMatch: boolean }[],
        effectiveSourcePubkey: string,
        weightingScheme?: WeightingScheme
    ): Promise<{ pubkey: string; profile: NostrProfile; trustScore: number; exactMatch: boolean }[]> {
        const results = await Promise.all(
            profiles.map(async ({ pubkey, profile, relevanceMultiplier, isExactMatch }) => {
                try {
                    const trustScore = await this.calculateTrustScore({
                        sourcePubkey: effectiveSourcePubkey,
                        targetPubkey: pubkey,
                        weightingScheme
                    });

                    const rawCombinedScore = trustScore.score * relevanceMultiplier;

                    return {
                        pubkey,
                        profile,
                        rawScore: rawCombinedScore,
                        exactMatch: isExactMatch
                    };
                } catch {
                    return {
                        pubkey,
                        profile,
                        rawScore: 0,
                        exactMatch: isExactMatch
                    };
                }
            })
        );

        const maxRawScore = Math.max(...results.map(r => r.rawScore), 1.0);

        return results.map(result => ({
            pubkey: result.pubkey,
            profile: result.profile,
            trustScore: result.rawScore / maxRawScore,
            exactMatch: result.exactMatch
        }));
    }

    private calculateRelevanceMultiplier(profile: NostrProfile, query: string): { multiplier: number; isExactMatch: boolean } {
        const queryLower = query.toLowerCase();
        let relevanceScore = 0;
        let isExactMatch = false;

        const fieldWeights = {
            name: 0.5,
            display_name: 0.35,
            nip05: 0.1,
            about: 0.05
        };

        for (const [field, weight] of Object.entries(fieldWeights)) {
            const fieldValue = profile[field as keyof NostrProfile];
            if (typeof fieldValue === 'string' && fieldValue.trim()) {
                const valueLower = fieldValue.toLowerCase();
                
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

        if (isExactMatch) {
            relevanceMultiplier *= 1.15;
        }

        return {
            multiplier: relevanceMultiplier,
            isExactMatch
        };
    }

    /**
     * Search profiles with optimized DuckDB integration
     * Leverages DuckDB's analytical capabilities for combined search and distance calculation
     */
    // TODO: This is not working
    async searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        if (!this.db) throw new RelatrError('Database not initialized', 'DATABASE_NOT_INITIALIZED');
        const { query, limit = 7, sourcePubkey, weightingScheme, extendToNostr } = params;

        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();

        // Simple LIKE-based search - we'll optimize with FTS later
        const searchResult = await this.db.run(`
            SELECT
                pubkey,
                name,
                display_name,
                nip05,
                lud16,
                about
            FROM pubkey_metadata
            WHERE
                name ILIKE $1 OR
                display_name ILIKE $1 OR
                nip05 ILIKE $1 OR
                lud16 ILIKE $1 OR
                about ILIKE $1
            LIMIT $2
        `, {
            1: `%${query}%`,
            2: limit * 3
        });

        const profilesWithRelevance = [];
        const rows = await searchResult.getRows();
        for (const row of rows) {
            const r = row as any;
            const profile = {
                pubkey: r.pubkey,
                name: r.name,
                display_name: r.display_name,
                nip05: r.nip05,
                lud16: r.lud16,
                about: r.about,
            };
            const { multiplier, isExactMatch } = this.calculateRelevanceMultiplier(profile, query);
            profilesWithRelevance.push({
                pubkey: r.pubkey,
                profile,
                relevanceMultiplier: multiplier,
                isExactMatch
            });
        }

        profilesWithRelevance.sort((a, b) => b.relevanceMultiplier - a.relevanceMultiplier);

        const nostrProfiles: { pubkey: string; profile: NostrProfile; relevanceMultiplier: number; isExactMatch: boolean }[] = [];
        const shouldExtendToNostr = extendToNostr || profilesWithRelevance.length === 0;
        
        if (shouldExtendToNostr) {
            const remaining = Math.max(0, limit - profilesWithRelevance.length);
            
            console.debug(`[RelatrService]  🔍 Extending search to Nostr relays for up to ${remaining} results`);

            const searchFilter = { kinds: [0], search: query, limit: remaining };

            try {
                if (this.pool) {
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
                        const existingPubkey = profilesWithRelevance.find(p => p.pubkey === event.pubkey);
                        if (!existingPubkey && !nostrProfiles.find(p => p.pubkey === event.pubkey)) {
                            const profile = JSON.parse(event.content);
                            const { multiplier, isExactMatch } = this.calculateRelevanceMultiplier(profile, query);
                            nostrProfiles.push({
                                pubkey: event.pubkey,
                                profile: { pubkey: event.pubkey, ...profile },
                                relevanceMultiplier: multiplier,
                                isExactMatch
                            });
                            this.metadataStore!.set(event.pubkey, { pubkey: event.pubkey, ...profile }).catch(err => {
                                console.warn(`[RelatrService] ️ Failed to cache profile for ${event.pubkey}:`, err);
                            });
                        }
                    }
                } else {
                    console.warn('[RelatrService]  ⚠️ Relay pool not available for Nostr search');
                }
            } catch {
                // Remote search failed or timed out, continue with local results only
            }
        }

        const finalProfiles = [...profilesWithRelevance, ...nostrProfiles];

        const profilesWithScores = await this.calculateProfileScores(
            finalProfiles,
            effectiveSourcePubkey,
            weightingScheme
        );

        profilesWithScores.forEach(profile => {
            if (profile.trustScore > 0.5 && nostrProfiles.find(p => p.pubkey === profile.pubkey)) {
                this.discoveryQueue.add(profile.pubkey);
                console.debug(`[RelatrService] 📥 Queued ${profile.pubkey} for contact discovery`);
            }
        });

        profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

        const results = profilesWithScores.slice(0, limit).map((item, index) => ({
            pubkey: item.pubkey,
            profile: item.profile,
            trustScore: item.trustScore,
            rank: index + 1,
            exactMatch: item.exactMatch
        }));

        const endTime = Date.now();
        console.log(`[RelatrService] Search completed in ${endTime - startTime}ms`);

        return {
            results,
            totalFound: results.length,
            searchTimeMs: endTime - startTime
        };
    }


    async getStats(): Promise<StatsResult> {
        const timestamp = Math.floor(Date.now() / 1000);

        try {
            // Get database stats
            let metricsTotalEntries = 0;
            let metadataTotalEntries = 0;

            if (this.metricsStore) {
                const metricsStats = await this.metricsStore.getStats();
                metricsTotalEntries = metricsStats.totalEntries;
            }
            if (this.metadataStore) {
                const metadataStats = await this.metadataStore.getStats();
                metadataTotalEntries = metadataStats.totalEntries;
            }

            // Get social graph stats
            let socialGraphStats = { users: 0, follows: 0, mutes: 0 };
            let rootPubkey = "";

            if (this.socialGraph) {
                const fullStats = await this.socialGraph.getStats();
                socialGraphStats = {
                    users: fullStats.users,
                    follows: fullStats.follows,
                    mutes: fullStats.mutes
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
                    stats: { users: 0, follows: 0, mutes: 0 },
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
        this.socialGraph?.cleanup();
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
        if (this.db) await closeDuckDB(this.db);

        this.db = null;
        this.socialGraph = null;
        this.trustCalculator = null;
        this.metricsValidator = null;
        this.metricsStore = null;
        this.metadataStore = null;
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
                if (this.db && this.initialized) {
                    const result = await cleanupExpiredDuckDBCache(this.db);
                    // Only log if entries were actually deleted
                    if (result.totalDeleted > 0) {
                        console.log(`[RelatrService] Background cleanup completed: ${result.totalDeleted} expired entries removed`);
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Background cleanup failed:', error instanceof Error ? error.message : String(error));
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
        console.log('[RelatrService] Starting profile sync and metrics pre-caching...');
        if (!this.pool || !this.db || !this.metricsValidator || !this.socialGraph || !this.metadataStore || !this.pubkeyMetadataFetcher) {
            throw new RelatrError('Service not properly initialized', 'NOT_INITIALIZED');
        }
        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const syncKey = `contact_sync:${effectiveSourcePubkey}`;
        console.log(`[RelatrService] Syncing profiles for ${hops} hops from ${effectiveSourcePubkey}`);
        try {
            // Check last sync time unless forced
            if (!force) {
                const lastSyncResult = await this.db.run(
                    'SELECT value FROM settings WHERE key = $1',
                    { 1: syncKey }
                );
                const rows = await lastSyncResult.getRows();
                const row = rows[0] as any;

                if (row) {
                    const lastSyncTime = parseInt(row.value);
                    if (Date.now() - lastSyncTime < this.config.syncInterval) {
                        console.log(`[RelatrService] Skipping contact sync - last sync was recent.`);
                        return;
                    }
                }
            }

            console.log('[RelatrService] Starting profile sync and metrics pre-caching...');
            // Step 1: Get all pubkeys from the social graph
            const discoveredPubkeys = await this.socialGraph.getAllUsersInGraph();
            
            // Step 2: Fetch metadata for ALL pubkeys to ensure we have the latest metadata            console.log(`[RelatrService] 📊 Fetching metadata for ${discoveredPubkeys.length.toLocaleString()} pubkeys`);
            
            await this.pubkeyMetadataFetcher.fetchMetadata({
                pubkeys: discoveredPubkeys,
                sourcePubkey: effectiveSourcePubkey
            });

            const now = Date.now();
            await this.db.run(
                'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($1, $2, $3)',
                { 1: syncKey, 2: now.toString(), 3: now }
            );

            console.log(`[RelatrService] Sync completed in ${Date.now() - startTime}ms`);

        } catch (error) {
            console.error('[RelatrService] Profile sync error:', error instanceof Error ? error.message : String(error));
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
    async syncValidations(batchSize: number = 50, sourcePubkey?: string): Promise<void> {
        console.log('[RelatrService] Starting validation sync...');
        if (!this.socialGraph || !this.metricsValidator || !this.metricsStore) {
            throw new RelatrError('Service not properly initialized for validation sync', 'NOT_INITIALIZED');
        }

        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;

        try {
            // Step 1: Get all pubkeys from the social graph
            const allPubkeys = await this.socialGraph.getAllUsersInGraph();
            console.log(`[RelatrService] 📊 Found ${allPubkeys.length.toLocaleString()} pubkeys in social graph`);

            // Step 2: Identify pubkeys without validation scores
            const pubkeysWithoutScores = (await this.metricsStore.getPubkeysWithoutValidationScores(allPubkeys)).slice(0, 100);
            console.log(`[RelatrService] 🔍 Found ${pubkeysWithoutScores.length.toLocaleString()} pubkeys missing validation scores`);

            if (pubkeysWithoutScores.length === 0) {
                console.log('[RelatrService] ✅ All pubkeys have validation scores, no sync needed');
                return;
            }

            // Step 3: Process validations in batches to avoid overwhelming the system
            let processedCount = 0;
            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < pubkeysWithoutScores.length; i += batchSize) {
                const batch = pubkeysWithoutScores.slice(i, i + batchSize);
                console.log(`[RelatrService] 🔄 Processing validation batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(pubkeysWithoutScores.length / batchSize)} (${batch.length} pubkeys)`);

                // Process batch in parallel for efficiency
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
                            console.warn(`[RelatrService] ⚠️ Validation failed for ${pubkey}:`, error instanceof Error ? error.message : String(error));
                        } else {
                            console.warn(`[RelatrService] ⚠️ Validation failed for unknown pubkey:`, result.reason instanceof Error ? result.reason.message : String(result.reason));
                        }
                    }
                }

                // Log progress
                console.log(`[RelatrService] 📈 Progress: ${processedCount}/${pubkeysWithoutScores.length} processed, ${successCount} successful, ${errorCount} failed`);
            }

            console.log(`[RelatrService] ✅ Validation sync completed in ${Date.now() - startTime}ms. Processed: ${processedCount}, Successful: ${successCount}, Failed: ${errorCount}`);

        } catch (error) {
            console.error('[RelatrService] Validation sync error:', error instanceof Error ? error.message : String(error));
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
                    console.log('[RelatrService] Starting periodic background sync...');
                    await this.syncProfiles(false, 1);
                    console.log('[RelatrService] Periodic sync completed');
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Periodic sync failed:', error instanceof Error ? error.message : String(error));
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
                    console.log('[RelatrService] Starting periodic validation sync...');
                    await this.syncValidations(50); // Process in batches of 50
                    console.log('[RelatrService] Periodic validation sync completed');
                    if (this.discoveryQueue.size > 0 && this.socialGraph) {
                        await this.processDiscoveryQueue();
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Periodic validation sync failed:', error instanceof Error ? error.message : String(error));
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
                console.log(`[RelatrService] 📁 Creating data directory: ${dataDir}`);

                // Create directory recursively
                await Bun.$`mkdir -p ${dataDir}`;

                console.log(`[RelatrService] ✅ Data directory created`);
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

    private escapeFts5Query(query: string): string {
        // DuckDB FTS handles query escaping automatically
        return query;
    }
}
