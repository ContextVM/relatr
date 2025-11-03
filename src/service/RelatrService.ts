import type {
    RelatrConfig,
    CalculateTrustScoreParams,
    TrustScore,
    StatsResult,
    ProfileMetrics,
    SearchProfilesParams,
    SearchProfilesResult,
    NostrProfile,
    WeightingScheme,
} from '../types';
import {
    RelatrError,
    SocialGraphError,
    ValidationError,
} from '../types';
import { RelayPool } from 'applesauce-relay';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, cleanupExpiredCache, isDatabaseHealthy } from '../database/connection';
import { SocialGraph as RelatrSocialGraph } from '../graph/SocialGraph';
import { SocialGraphBuilder } from '../graph/SocialGraphBuilder';
import { PubkeyMetadataFetcher } from '../graph/PubkeyMetadataFetcher';
import { TrustCalculator } from '../trust/TrustCalculator';
import { MetricsValidator } from '../validators/MetricsValidator';
import { createWeightProfileManager, RelatrConfigSchema } from '../config';
import { sanitizeProfile } from '@/utils/utils';
import { DataStore } from '@/database/data-store';
import type { NostrEvent } from 'nostr-social-graph';
import { dirname } from 'path';
import { validateAndDecodePubkey } from '@/utils/utils.nostr';

export class RelatrService {
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
    ];
    private config: RelatrConfig;
    private db: Database | null = null;
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

            // Step 1: Initialize database and caches
            this.db = initDatabase(this.config.databasePath);
            this.metricsStore = new DataStore(this.db, 'profile_metrics', this.config.cacheTtlSeconds);
            this.metadataStore = new DataStore(this.db, 'pubkey_metadata');

            // Step 2: Initialize network components and builders first
            this.pool = new RelayPool();
            this.socialGraphBuilder = new SocialGraphBuilder(this.config, this.pool);
            this.pubkeyMetadataFetcher = new PubkeyMetadataFetcher(this.pool,this.metadataStore );

            // Step 3: Check if social graph exists and handle first-time setup
            const graphExists = await Bun.file(this.config.graphBinaryPath).exists();

            if (!graphExists) {
                console.log(`[RelatrService] 🆕 Social graph not found at ${this.config.graphBinaryPath}. Creating new graph...`);

                await this.socialGraphBuilder.createGraph({
                sourcePubkey: this.config.defaultSourcePubkey,
                hops: this.config.numberOfHops
            });

                console.log('[RelatrService] ✅ Social graph created successfully.');
            }

            // Step 4: Initialize the social graph
            this.socialGraph = new RelatrSocialGraph(this.config.graphBinaryPath);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            console.log('[RelatrService] Social graph stats', this.socialGraph.getStats());
            // Step 5: Initialize trust calculation components
            const weightProfileManager = createWeightProfileManager();
            this.trustCalculator = new TrustCalculator(this.config, weightProfileManager);
            this.metricsValidator = new MetricsValidator(this.pool, this.config.nostrRelays, this.socialGraph, this.metricsStore, undefined, weightProfileManager);

            this.initialized = true;

            // Step 6: If this is the first time running, fetch initial metadata
            if (!graphExists && (await this.metadataStore.getStats()).totalEntries === 0) {
                console.log('[RelatrService] 👤 Fetching initial profile metadata...');
                const pubkeys = this.socialGraph.getUsersUpToDistance(this.config.numberOfHops);
                console.log(`[RelatrService] 📊 Found ${pubkeys.length.toLocaleString()} pubkeys within ${this.config.numberOfHops} hops for metadata fetching`);
                await this.pubkeyMetadataFetcher.fetchMetadata({
                    pubkeys,
                    sourcePubkey: this.config.defaultSourcePubkey
                });
            }
            console.log('[RelatrService] Starting background processes...');
            // Step 7: Start background processes
            this.startBackgroundCleanup();
            this.startPeriodicSync();

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
                : this.socialGraph!.getDistance(decodedTargetPubkey);

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


    /**
     * Helper method to calculate trust scores for profiles with optimized object creation
     * @private
     */
    private async calculateProfileScores(
        pubkeys: string[],
        effectiveSourcePubkey: string,
        weightingScheme?: WeightingScheme,
        searchQuery?: string
    ): Promise<{ pubkey: string; profile: NostrProfile; trustScore: number; exactMatch: boolean }[]> {
        return Promise.all(
            pubkeys.map(async (pubkey) => {
                try {
                    // Try to get profile from metadata cache
                    let profile = await this.metadataStore!.get(pubkey);

                    // If not in cache, create minimal profile
                    if (!profile) {
                        profile = { pubkey };
                    }

                    // Sanitize profile to remove null values
                    const sanitizedProfile = sanitizeProfile(profile);

                    const trustScore = await this.calculateTrustScore({
                        sourcePubkey: effectiveSourcePubkey,
                        targetPubkey: pubkey,
                        weightingScheme
                    });

                    // Calculate relevance boost and exact match status
                    let relevanceBoost = 0;
                    let exactMatch = false;

                    if (searchQuery) {
                        const query = searchQuery.toLowerCase();
                        const name = profile.name?.toLowerCase() || '';
                        const displayName = profile.display_name?.toLowerCase() || '';

                        // Calculate relevance boost and exact match status
                        if ((name === query || displayName === query) && trustScore.score > 0.5) {
                            relevanceBoost = 0.15;
                            exactMatch = true;
                        }
                    }

                    // Combine trust score and relevance boost, normalize to 0-1 range
                    const combinedScore = Math.min(1, trustScore.score + relevanceBoost);

                    return {
                        pubkey,
                        profile: sanitizedProfile,
                        trustScore: combinedScore,
                        exactMatch
                    };
                } catch (error) {
                    // Assign score 0 on error but include in results
                    return {
                        pubkey,
                        profile: { pubkey },
                        trustScore: 0,
                        exactMatch: false
                    };
                }
            })
        );
    }

    async searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult> {
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        if (!this.db) throw new RelatrError('Database not initialized', 'DATABASE_NOT_INITIALIZED');
        const { query, limit = 7, sourcePubkey, weightingScheme, extendToNostr } = params;

        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();

        const prepared = this.db.prepare(
            `SELECT pubkey FROM pubkey_metadata WHERE pubkey_metadata MATCH ? LIMIT ?`
        )

        // Use FTS5 prefix matching (query*) to support partial matches
        const dbPubkeys = prepared.all(`${query}*`, limit * 7) as { pubkey: string }[];

        const localPubkeys = dbPubkeys.map(row => row.pubkey);

        // Fast path: If we have enough local results and are not extending the search, process them directly.
        if (localPubkeys.length >= limit && !extendToNostr) {
            const profilesWithScores = await this.calculateProfileScores(
                localPubkeys,
                effectiveSourcePubkey,
                weightingScheme,
                query
            );

            // Sort by combined score (trust score + relevance boost)
            profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

            const results = profilesWithScores.slice(0, limit).map((item, index) => ({
                pubkey: item.pubkey,
                profile: item.profile,
                trustScore: item.trustScore,
                rank: index + 1,
                exactMatch: item.exactMatch
            }));
                return {
                    results,
                    totalFound: localPubkeys.length,
                    searchTimeMs: Date.now() - startTime
            }
        }

        // Step 2: If needed, query Nostr relays to extend the search.
        const nostrPubkeys: string[] = [];
        const remaining = limit - localPubkeys.length;

        if (extendToNostr || localPubkeys.length == 0) {
            const nostrLimit = extendToNostr ? Math.max(limit, remaining) : remaining;
            console.debug(`[RelatrService] 🔍 Extending search to Nostr relays for up to ${nostrLimit} results`);

            const searchFilter = { kinds: [0], search: query, limit: nostrLimit };

            try {
                if (this.pool) {
                    const nostrEvents = await new Promise<NostrEvent[]>((resolve, reject) => {
                        const events: NostrEvent[] = [];
                        const subscription = this.pool!.request(
                            RelatrService.SEARCH_RELAYS,
                            searchFilter,
                            {
                                retries: 1
                            }
                        ).subscribe({
                            next: (event) => {
                                events.push(event);
                            },
                            error: (error) => {
                                reject(error);
                            },
                            complete: () => {
                                resolve(events);
                            }
                        });

                        // Auto-unsubscribe after timeout
                        setTimeout(() => {
                            subscription.unsubscribe();
                            resolve(events);
                        }, 5000);
                    });

                    for (const event of nostrEvents) {
                        if (!localPubkeys.includes(event.pubkey)) {
                            nostrPubkeys.push(event.pubkey);
                            // Asynchronously cache profile metadata without awaiting.
                            const profile = JSON.parse(event.content);
                            this.metadataStore!.set(event.pubkey, { pubkey: event.pubkey, ...profile }).catch(err => {
                                console.warn(`[RelatrService] ⚠️ Failed to cache profile for ${event.pubkey}:`, err);
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`[RelatrService] ❌ Remote search failed or timed out:`, error);
            }
        }

        // Step 3: Merge local and Nostr results, then calculate scores.
        const allPubkeys = Array.from(new Set([...localPubkeys, ...nostrPubkeys]));

        const profilesWithScores = await this.calculateProfileScores(
            allPubkeys,
            effectiveSourcePubkey,
            weightingScheme,
            query
        );

        // Step 4: Sort, rank, and return the final results.
        // Sort by combined score (trust score + relevance boost)
        profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

        const results = profilesWithScores.slice(0, limit).map((item, index) => ({
            pubkey: item.pubkey,
            profile: item.profile,
            trustScore: item.trustScore,
            rank: index + 1,
            exactMatch: item.exactMatch
        }));

        return {
            results,
            totalFound: allPubkeys.length,
            searchTimeMs: Date.now() - startTime
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
            let socialGraphStats = { users: 0, follows: 0 };
            let rootPubkey = "";

            if (this.socialGraph) {
                socialGraphStats = this.socialGraph.getStats();
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
        this.socialGraph?.cleanup();
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        if (this.db) closeDatabase(this.db);

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
                    const result = cleanupExpiredCache(this.db);
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
        if (!this.pool || !this.db || !this.metricsValidator || !this.socialGraph) {
            throw new RelatrError('Service not properly initialized', 'NOT_INITIALIZED');
        }
        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const syncKey = `contact_sync:${effectiveSourcePubkey}`;
        console.log(`[RelatrService] Syncing profiles for ${hops} hops from ${effectiveSourcePubkey}`);
        try {
            // Check last sync time unless forced
            if (!force) {
                const lastSyncResult = this.db.query(
                    'SELECT value FROM settings WHERE key = ?'
                ).get(syncKey) as { value: string } | undefined;

                if (lastSyncResult) {
                    const lastSyncTime = parseInt(lastSyncResult.value);
                    if (Date.now() - lastSyncTime < this.config.syncInterval) {
                        console.log(`[RelatrService] Skipping contact sync - last sync was recent.`);
                        return;
                    }
                }
            }

            console.log('[RelatrService] Starting profile sync and metrics pre-caching...');

            // Use the PubkeyMetadataFetcher to cache profile metadata
            const discoveredPubkeys = this.socialGraph.getUsersUpToDistance(this.config.numberOfHops);

            await this.pubkeyMetadataFetcher!.fetchMetadata({
                pubkeys: discoveredPubkeys,
                sourcePubkey: effectiveSourcePubkey
            });

            const now = Date.now();
            this.db.run(
                'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                [syncKey, now.toString(), now]
            );

            console.log(`[RelatrService] Sync completed in ${Date.now() - startTime}ms`);

        } catch (error) {
            console.error('[RelatrService] Profile sync error:', error instanceof Error ? error.message : String(error));
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
}
