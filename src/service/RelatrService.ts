import type {
    RelatrConfig,
    CalculateTrustScoreParams,
    TrustScore,
    HealthCheckResult,
    ManageCacheResult,
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
    DataStoreError
} from '../types';
import { SimplePool } from 'nostr-tools/pool';
import { RelayPool } from 'applesauce-relay';
import { EventStore } from 'applesauce-core';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, cleanupExpiredCache, isDatabaseHealthy } from '../database/connection';
import { SocialGraph as RelatrSocialGraph } from '../graph/SocialGraph';
import { SocialGraphBuilder } from '../graph/SocialGraphBuilder';
import { PubkeyMetadataFetcher } from '../graph/PubkeyMetadataFetcher';
import { TrustCalculator } from '../trust/TrustCalculator';
import { MetricsValidator } from '../validators/MetricsValidator';
import { createWeightProfileManager } from '../config';
import { sanitizeProfile, withTimeout } from '@/utils';
import { DataStore } from '@/database/data-store';

export class RelatrService {
    private static readonly BATCH_SIZE = 500;
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
    ];
    private static readonly SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000 * 7; // 7 hours

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
    private searchPool: SimplePool | null = null;
    private initialized = false;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private syncInterval: NodeJS.Timeout | null = null;
    private eventStore: EventStore | null = null;

    constructor(config: RelatrConfig) {
        if (!config) throw new RelatrError('Configuration required', 'CONSTRUCTOR');
        
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

        this.config = { ...config };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            // Step 1: Initialize database and caches
            this.db = initDatabase(this.config.databasePath);
            this.metricsStore = new DataStore(this.db, 'profile_metrics', this.config.cacheTtlSeconds);
            this.metadataStore = new DataStore(this.db, 'pubkey_metadata');
            
            // Step 2: Initialize network components and builders first
            this.pool = new RelayPool();
            this.searchPool = new SimplePool();
            this.eventStore = new EventStore();
            this.socialGraphBuilder = new SocialGraphBuilder(this.config, this.pool!, this.eventStore);
            this.pubkeyMetadataFetcher = new PubkeyMetadataFetcher(this.pool!, this.eventStore, this.metadataStore!);
            
            // Step 3: Check if social graph exists and handle first-time setup
            const file = Bun.file(this.config.graphBinaryPath);
            const exists = await file.exists();
            
            if (!exists) {
                console.log(`[RelatrService] 🆕 Social graph not found at ${this.config.graphBinaryPath}. Creating new graph...`);
                
                await this.socialGraphBuilder.createGraph({
                sourcePubkey: this.config.defaultSourcePubkey,
                hops: 2
            });
    
                console.log('[RelatrService] ✅ Social graph created successfully.');
            }
            
            // Step 4: Initialize the social graph (after creation or if it already exists)
            this.socialGraph = new RelatrSocialGraph(this.config.graphBinaryPath);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            
            // Step 5: Initialize trust calculation components
            const weightProfileManager = createWeightProfileManager();
            this.trustCalculator = new TrustCalculator(this.config, weightProfileManager);
            this.metricsValidator = new MetricsValidator(this.config.nostrRelays, this.socialGraph, this.metricsStore, weightProfileManager);
            
            this.initialized = true;
            
            // Step 6: If this is the first time running, fetch initial metadata
            if (!exists) {
                console.log('[RelatrService] 👤 Fetching initial profile metadata...');
                const pubkeys = this.socialGraph.getUsersUpToDistance(2);
                console.log(`[RelatrService] 📊 Found ${pubkeys.length.toLocaleString()} pubkeys within 2 hops for metadata fetching`);
                await this.pubkeyMetadataFetcher.fetchMetadata({
                    pubkeys,
                    sourcePubkey: this.config.defaultSourcePubkey
                });
            }
            
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

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        if (!effectiveSourcePubkey || typeof effectiveSourcePubkey !== 'string') {
            throw new ValidationError('Invalid source pubkey', 'sourcePubkey');
        }

        try {
            const distance = effectiveSourcePubkey !== this.socialGraph!.getCurrentRoot()
                ? await this.socialGraph!.getDistanceBetween(effectiveSourcePubkey, targetPubkey)
                : this.socialGraph!.getDistance(targetPubkey);

            const metrics = await this.metricsValidator!.validateAll(targetPubkey, effectiveSourcePubkey);
            
            if (weightingScheme) {
                const weightProfileManager = this.metricsValidator!.getWeightProfileManager();
                weightProfileManager.activateProfile(weightingScheme);
            }
            
            const trustScore = this.trustCalculator!.calculate(
                effectiveSourcePubkey, targetPubkey, metrics, distance
            );
            return trustScore;

        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError || 
                error instanceof SocialGraphError || error instanceof DataStoreError) {
                throw error;
            }
            throw new RelatrError(`Calc failed: ${error instanceof Error ? error.message : String(error)}`, 'CALCULATE');
        }
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
    
        const { query, limit = 7, sourcePubkey, weightingScheme, extendToNostr } = params;
    
        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }
    
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();
    
        // Step 1: Search local FTS5 database for an initial set of candidates.
        const dbPubkeys = this.db!.query(
            `SELECT pubkey FROM pubkey_metadata WHERE pubkey_metadata MATCH ? LIMIT ?`
        ).all(query, limit * 3) as { pubkey: string }[];
    
        const localPubkeys = dbPubkeys.map(row => row.pubkey);
    
        // Fast path: If we have enough local results and are not extending the search, process them directly.
        if (localPubkeys.length >= limit && !extendToNostr) {
            const profilesWithScores = await this.calculateProfileScores(
                localPubkeys,
                effectiveSourcePubkey,
                weightingScheme
            );
    
            profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);
    
            const results = profilesWithScores.slice(0, limit).map((item, index) => ({
                pubkey: item.pubkey,
                profile: item.profile,
                trustScore: item.trustScore,
                rank: index + 1
            }));
    
            return {
                results,
                totalFound: localPubkeys.length,
                searchTimeMs: Date.now() - startTime
            };
        }
    
        // Step 2: If needed, query Nostr relays to extend the search.
        const nostrPubkeys: string[] = [];
        const remaining = limit - localPubkeys.length;
        const shouldQueryNostr = extendToNostr || localPubkeys.length === 0;
    
        if (shouldQueryNostr && (extendToNostr || remaining > 0)) {
            const nostrLimit = extendToNostr ? Math.max(limit, remaining) : remaining;
            console.debug(`[RelatrService] 🔍 Extending search to Nostr relays for up to ${nostrLimit} results`);
    
            const searchFilter = { kinds: [0], search: query, limit: nostrLimit };
    
            try {
                const nostrEvents = this.searchPool
                    ? await withTimeout(
                        this.searchPool.querySync(RelatrService.SEARCH_RELAYS, searchFilter),
                        3000 // 3-second timeout for remote search
                    )
                    : [];
    
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
            } catch (error) {
                console.error(`[RelatrService] ❌ Remote search failed or timed out:`, error);
            }
        }
    
        // Step 3: Merge local and Nostr results, then calculate scores.
        const allPubkeys = Array.from(new Set([...localPubkeys, ...nostrPubkeys]));
    
        const profilesWithScores = await this.calculateProfileScores(
            allPubkeys,
            effectiveSourcePubkey,
            weightingScheme
        );
    
        // Step 4: Sort, rank, and return the final results.
        profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);
    
        const results = profilesWithScores.slice(0, limit).map((item, index) => ({
            pubkey: item.pubkey,
            profile: item.profile,
            trustScore: item.trustScore,
            rank: index + 1
        }));
    
        return {
            results,
            totalFound: allPubkeys.length,
            searchTimeMs: Date.now() - startTime
        };
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
                        ? await this.metricsStore!.clear(targetPubkey)
                        : await this.metricsStore!.clear();
                    
                    return {
                        success: true,
                        metricsCleared,
                        message: targetPubkey ? `Cleared ${targetPubkey}` : 'Cleared all'
                    };
                }
                case 'cleanup': {
                    const metricsDeleted = await this.metricsStore!.cleanup();
                    return {
                        success: true,
                        metricsCleared: metricsDeleted,
                        message: `Cleaned ${metricsDeleted} metrics`
                    };
                }
                case 'stats': {
                    const metricsStats = await this.metricsStore!.getStats();

                    return {
                        success: true,
                        message: `Metrics: ${metricsStats.totalEntries}/${metricsStats.expiredEntries}`
                    };
                }
                default:
                    throw new ValidationError(`Invalid action: ${action}`, 'action');
            }
        } catch (error) {
            if (error instanceof ValidationError || error instanceof DataStoreError) throw error;
            throw new DataStoreError(`Cache failed: ${error instanceof Error ? error.message : String(error)}`, action);
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
        this.searchPool = null;
        this.eventStore = null;
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
        }, RelatrService.CLEANUP_INTERVAL_MS);
    }

    /**
     * Sync Nostr profiles and update trust metrics
     * @param force Force sync even if recent
     * @param hops Number of hops to sync (default: 1)
     * @param sourcePubkey Source pubkey to sync from
     */
    async syncProfiles(force: boolean = false, hops: number = 1, sourcePubkey?: string): Promise<void> {
        if (!this.pool || !this.db || !this.metricsValidator || !this.socialGraph) {
            throw new RelatrError('Service not properly initialized', 'NOT_INITIALIZED');
        }
    
        const startTime = Date.now();
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const syncKey = `contact_sync:${effectiveSourcePubkey}`;
    
        try {
            // Check last sync time unless forced
            if (!force) {
                const lastSyncResult = this.db.query(
                    'SELECT value FROM settings WHERE key = ?'
                ).get(syncKey) as { value: string } | undefined;
    
                if (lastSyncResult) {
                    const lastSyncTime = parseInt(lastSyncResult.value);
                    if (Date.now() - lastSyncTime < RelatrService.SYNC_INTERVAL_MS) {
                        console.log(`[RelatrService] Skipping contact sync - last sync was recent.`);
                        return;
                    }
                }
            }
    
            console.log('[RelatrService] Starting profile sync and metrics pre-caching...');
            
            // Use the PubkeyMetadataFetcher to cache profile metadata
            const discoveredPubkeys = this.socialGraph.getUsersUpToDistance(2);

            await this.pubkeyMetadataFetcher!.fetchMetadata({
                pubkeys: discoveredPubkeys,
                sourcePubkey: effectiveSourcePubkey
            });
    
            // Pre-cache metrics for discovered pubkeys
            if (discoveredPubkeys.length > 0) {
                console.log(`[RelatrService] Pre-caching metrics for ${discoveredPubkeys.length} profiles...`);
                
                const preCachePromises = discoveredPubkeys.map(async (pubkey) => {
                    try {
                        await this.metricsValidator!.validateAll(pubkey, effectiveSourcePubkey);
                    } catch (error) {
                        console.warn(`[RelatrService] Failed to pre-cache metrics for ${pubkey}:`, error);
                    }
                });
                
                await Promise.allSettled(preCachePromises);
            }
    
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
                    await this.syncProfiles(false, 1); // Non-forced, 1 hop sync
                    console.log('[RelatrService] Periodic sync completed');
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Periodic sync failed:', error instanceof Error ? error.message : String(error));
            }
        }, RelatrService.SYNC_INTERVAL_MS);
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): RelatrSocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }
}