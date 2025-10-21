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
    FetchNostrEventsParams,
    FetchNostrEventsResult,
} from '../types';
import {
    RelatrError,
    SocialGraphError,
    ValidationError,
    CacheError
} from '../types';
import { SimplePool } from 'nostr-tools/pool';
import { RelayPool } from 'applesauce-relay';
import { EventStore } from 'applesauce-core';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, cleanupExpiredCache, isDatabaseHealthy } from '../database/connection';
import { SimpleCache } from '../database/cache';
import { SocialGraph } from '../graph/SocialGraph';
import { TrustCalculator } from '../trust/TrustCalculator';
import { MetricsValidator } from '../validators/MetricsValidator';
import { createWeightProfileManager } from '../config';
import { withTimeout } from '@/utils';
import type { Filter, NostrEvent } from 'nostr-tools';

export class RelatrService {
    private static readonly BATCH_SIZE = 500;
    private static readonly SEARCH_RELAYS = [
        'wss://relay.nostr.band',
        'wss://search.nos.today',
    ];

    private config: RelatrConfig;
    private db: Database | null = null;
    private socialGraph: SocialGraph | null = null;
    private trustCalculator: TrustCalculator | null = null;
    private metricsValidator: MetricsValidator | null = null;
    private metricsCache: SimpleCache<ProfileMetrics> | null = null;
    private metadataCache: SimpleCache<NostrProfile> | null = null;
    private pool: RelayPool | null = null;
    private searchPool: SimplePool | null = null;
    private initialized = false;
    private cleanupInterval: NodeJS.Timeout | null = null;

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

        this.config = { ...config };
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            this.db = initDatabase(this.config.databasePath);
            // Pass the database instance to cache constructor for consistency
            this.metricsCache = new SimpleCache(this.db, 'profile_metrics', this.config.cacheTtlSeconds);
            this.metadataCache = new SimpleCache(this.db, 'pubkey_metadata');
            this.socialGraph = new SocialGraph(this.config.graphBinaryPath);
            await this.socialGraph.initialize(this.config.defaultSourcePubkey);
            // Create weight profile manager and initialize with default profile
            const weightProfileManager = createWeightProfileManager();
            this.trustCalculator = new TrustCalculator(this.config, weightProfileManager);
            this.metricsValidator = new MetricsValidator(this.config.nostrRelays, this.socialGraph, this.metricsCache, weightProfileManager);
            this.pool = new RelayPool();
            this.searchPool = new SimplePool();
            this.initialized = true;
            
            // Start background cleanup - run every 30 minutes (1800000 ms)
            this.startBackgroundCleanup();
            
            // Sync contact profiles asynchronously (non-blocking)
            this.syncContactProfiles().catch(error => {
                console.error('[RelatrService] Contact sync failed:', error);
            });
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
            
            // Handle weighting scheme - use the new weight profile system
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
    
        const { query, limit = 7, sourcePubkey, weightingScheme, extendToNostr } = params;
    
        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }
    
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();
    
        // Step 1: Search local FTS5 database for an initial set of candidates.
        const dbPubkeys = this.db!.query(
            `SELECT pubkey FROM pubkey_metadata WHERE pubkey_metadata MATCH ? LIMIT ?`
        ).all(query, limit * 3) as { pubkey: string }[]; // Fetch 3x for a larger candidate pool
    
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
    
        // Step 2: If needed, query Nostr relays to supplement or extend the search.
        const nostrPubkeys: string[] = [];
        const remaining = limit - localPubkeys.length;
        const shouldQueryNostr = extendToNostr || localPubkeys.length === 0;
    
        if (shouldQueryNostr && (extendToNostr || remaining > 0)) {
            const nostrLimit = extendToNostr ? Math.max(limit, remaining) : remaining;
            console.debug(`[RelatrService] searchProfiles: querying nostr for up to ${nostrLimit} results`);
    
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
                        this.metadataCache!.set(event.pubkey, { pubkey: event.pubkey, ...profile }).catch(err => {
                            console.warn(`[RelatrService] Failed to cache profile for ${event.pubkey}:`, err);
                        });
                    }
                }
            } catch (error) {
                console.error(`[RelatrService] Remote search failed or timed out:`, error);
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

    async fetchNostrEvents(params: FetchNostrEventsParams): Promise<FetchNostrEventsResult> {
        console.debug("FETCHING EVENTS");
        if (!this.initialized) throw new RelatrError('Not initialized', 'NOT_INITIALIZED');
        const { sourcePubkey, hops = 1, kind } = params;
        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
    
        if (kind !== 0 && kind !== 3) {
            throw new ValidationError('Invalid kind specified. Must be 0 or 3.', 'kind');
        }
    
        if (hops < 0 || hops > 5) {
            throw new ValidationError('Hops must be between 0 and 5.', 'hops');
        }

        console.debug("HOPS", hops);
        const NEG_RELAYS = ['wss://relay.damus.io']
        try {
            const startTime = Date.now();
            const eventStore = new EventStore();
            let pubkeysToCrawl: Set<string> = new Set([effectiveSourcePubkey]);
            const crawledPubkeys: Set<string> = new Set();
            let totalEventsFetched = 0;
    
            for (let hop = 0; hop <= hops; hop++) {
                if (pubkeysToCrawl.size === 0) {
                    console.error(`[RelatrService] Hop ${hop}: No new pubkeys to crawl.`);
                    break;
                }
    
                const pubkeysForThisHop = Array.from(pubkeysToCrawl);
                pubkeysForThisHop.forEach(pk => crawledPubkeys.add(pk));
                pubkeysToCrawl.clear();
                console.debug("PUBKEYS FOR THIS HOP", pubkeysForThisHop);
    
                // Track whether we discover any new pubkeys during this hop; if none, stop early.
                let newDiscoveredThisHop = 0;
    
                for (let i = 0; i < pubkeysForThisHop.length; i += RelatrService.BATCH_SIZE) {
                    const batch = pubkeysForThisHop.slice(i, i + RelatrService.BATCH_SIZE);
                    
                    const events = await this.fetchEventsFromRelays(NEG_RELAYS, {
                        kinds: [3],
                        authors: batch,
                    }, eventStore);
                    console.debug("EVENTS", events);
    
                    for (const event of events) {
                        // iterate tags and only add truly new pubkeys (not crawled and not already queued)
                        for (const tag of event.tags) {
                            if (tag[0] !== 'p') continue;
                            const candidate = tag[1];
                            if (!candidate) continue;
                            if (crawledPubkeys.has(candidate)) continue;
                            if (pubkeysToCrawl.has(candidate)) continue;
                            pubkeysToCrawl.add(candidate);
                            newDiscoveredThisHop++;
                        }
                    }
                }
    
                if (newDiscoveredThisHop === 0) {
                    console.error(`[RelatrService] Hop ${hop}: no new pubkeys discovered, stopping early.`);
                    break;
                }
            }
    
            const finalPubkeys = Array.from(crawledPubkeys);
            for (let i = 0; i < finalPubkeys.length; i += RelatrService.BATCH_SIZE) {
                const batch = finalPubkeys.slice(i, i + RelatrService.BATCH_SIZE);
                const events = await this.fetchEventsFromRelays(NEG_RELAYS, {
                    kinds: [kind],
                    authors: batch,
                });
    
                if (kind === 0) {
                    for (const event of events) {
                        try {
                            const profile = JSON.parse(event.content);
                            await this.metadataCache!.set(event.pubkey, {
                                pubkey: event.pubkey,
                                name: profile.name,
                                display_name: profile.display_name,
                                nip05: profile.nip05,
                                lud16: profile.lud16,
                                about: profile.about,
                            });
                            totalEventsFetched++;
                        } catch (e) { /* ignore invalid profile */ }
                    }
                } else {
                    totalEventsFetched += events.length;
                }
            }
    
            const duration = Date.now() - startTime;
            const message = `Fetched ${totalEventsFetched} kind ${kind} events for ${crawledPubkeys.size} pubkeys across ${hops} hops in ${duration}ms.`;
            console.error(`[RelatrService] ${message}`);
    
            return {
                success: true,
                eventsFetched: totalEventsFetched,
                message,
                pubkeys: finalPubkeys,
            };
    
        } catch (error) {
            if (error instanceof RelatrError || error instanceof ValidationError || error instanceof CacheError) {
                throw error;
            }
            throw new RelatrError(`Event fetch failed: ${error instanceof Error ? error.message : String(error)}`, 'FETCH_EVENTS');
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
        if (this.db) closeDatabase(this.db);
        
        this.db = null;
        this.socialGraph = null;
        this.trustCalculator = null;
        this.metricsValidator = null;
        this.metricsCache = null;
        this.metadataCache = null;
        this.pool = null;
        this.searchPool = null;
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
        
        // Run cleanup every 30 minutes (1800000 ms)
        this.cleanupInterval = setInterval(async () => {
            try {
                if (this.db && this.initialized) {
                    const result = cleanupExpiredCache(this.db);
                    // Only log if entries were actually deleted
                    if (result.totalDeleted > 0) {
                        console.error(`[RelatrService] Background cleanup completed: ${result.totalDeleted} expired entries removed`);
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Background cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }, 60 * 60 * 1000 * 7);
    }

    /**
     * Sync contact profiles from source pubkey's contact network
     * @private
     */
    private async syncContactProfiles(): Promise<void> {
        if (!this.pool || !this.db || !this.metricsValidator) return;
    
        const startTime = Date.now();
        const syncKey = `contact_sync:${this.config.defaultSourcePubkey}`;
        const syncInterval = 24 * 60 * 60 * 1000; // 24 hours
    
        try {
            const lastSyncResult = this.db.query(
                'SELECT value FROM settings WHERE key = ?'
            ).get(syncKey) as { value: string } | undefined;
    
            if (lastSyncResult) {
                const lastSyncTime = parseInt(lastSyncResult.value);
                if (Date.now() - lastSyncTime < syncInterval) {
                    console.debug(`[RelatrService] Skipping contact sync - last sync was recent.`);
                    return;
                }
            }
    
            console.error('[RelatrService] Starting contact profile sync and metrics pre-caching...');
            
            // Step 1: Fetch contact profiles (kind: 0) and get their pubkeys.
            const { eventsFetched, pubkeys } = await this.fetchNostrEvents({
                sourcePubkey: this.config.defaultSourcePubkey,
                hops: 1, // 1 hop for direct contacts
                kind: 0,
            });
    
            if (pubkeys && pubkeys.length > 0) {
                console.error(`[RelatrService] Pre-caching metrics for ${pubkeys.length} contact profiles...`);
                
                // Step 2: Pre-cache metrics for each fetched pubkey.
                for (const pubkey of pubkeys) {
                    try {
                        // This will fetch, validate, and cache the metrics.
                        await this.metricsValidator.validateAll(pubkey, this.config.defaultSourcePubkey);
                    } catch (error) {
                        console.warn(`[RelatrService] Failed to pre-cache metrics for ${pubkey}:`, error);
                    }
                }
            }
    
            const now = Date.now();
            this.db.run(
                'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                [syncKey, now.toString(), now]
            );
    
            console.error(`[RelatrService] Synced ${eventsFetched} profiles and pre-cached metrics in ${Date.now() - startTime}ms`);
        } catch (error) {
            console.error('[RelatrService] Contact sync error:', error instanceof Error ? error.message : String(error));
        }
    }

    private async fetchEventsFromRelays(relays: string[], filter: Filter, eventStore?: EventStore): Promise<NostrEvent[]> {
        if (!this.pool) {
            throw new RelatrError('Relay pool not initialized', 'NOT_INITIALIZED');
        }
        console.debug("FETCHING EVENTS FROM", relays);
        // Negentropy sync: subscribe and collect events, then end collection on inactivity or overall timeout.
        const eventsObservable = this.pool.sync(relays, eventStore || new EventStore(), filter);
    
        const collected: NostrEvent[] = [];
        const inactivityMs = 500; // consider sync finished if no events for 500ms
        const overallTimeoutMs = 10000; // hard cap for the whole operation
    
        return await new Promise<NostrEvent[]>((resolve) => {
            let inactiveTimer: NodeJS.Timeout | null = null;
            const clearInactive = () => {
                if (inactiveTimer) {
                    clearTimeout(inactiveTimer);
                    inactiveTimer = null;
                }
            };
    
            const maxTimer = setTimeout(() => {
                try {
                    subscription.unsubscribe();
                } catch (_) { /* ignore */ }
                clearInactive();
                console.error(`[RelatrService] fetchEventsFromRelays overall timeout after ${overallTimeoutMs}ms for ${JSON.stringify(relays)}`);
                resolve(collected);
            }, overallTimeoutMs);
    
            const endDueToInactivity = () => {
                try {
                    subscription.unsubscribe();
                } catch (_) { /* ignore */ }
                clearTimeout(maxTimer);
                clearInactive();
                resolve(collected);
            };
    
            const resetInactivity = () => {
                clearInactive();
                inactiveTimer = setTimeout(endDueToInactivity, inactivityMs);
            };
    
            const subscription = eventsObservable.subscribe({
                next: (ev: NostrEvent) => {
                    collected.push(ev);
                    resetInactivity();
                },
                error: (err) => {
                    console.error(`[RelatrService] fetchEventsFromRelays observable error for ${JSON.stringify(relays)}:`, err instanceof Error ? err.message : String(err));
                    clearTimeout(maxTimer);
                    clearInactive();
                    try { subscription.unsubscribe(); } catch (_) {}
                    resolve(collected);
                },
                complete: () => {
                    clearTimeout(maxTimer);
                    clearInactive();
                    resolve(collected);
                }
            });
    
            // Start the inactivity timer in case the observable emits immediately or never emits
            resetInactivity();
        });
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): SocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }
}