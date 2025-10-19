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
    WeightingScheme
} from '../types';
import { 
    RelatrError, 
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
import { createWeightProfileManager } from '../config';
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

        const { query, limit = 7, sourcePubkey, weightingScheme } = params;
        
        if (!query || typeof query !== 'string') {
            throw new ValidationError('Invalid search query', 'query');
        }

        const effectiveSourcePubkey = sourcePubkey || this.config.defaultSourcePubkey;
        const startTime = Date.now();
        
        // Step 1: Search local FTS5 database
        const dbPubkeys = this.db!.query(
            `SELECT pubkey FROM pubkey_metadata WHERE pubkey_metadata MATCH ? LIMIT ?`
        ).all(query, limit * 2) as { pubkey: string }[]; // Fetch 2x for better filtering
        
        const localPubkeys = dbPubkeys.map(row => row.pubkey);
        
        // Step 2: If we have enough results, calculate trust scores and return
        if (localPubkeys.length >= limit) {
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
        
        // Step 3: Fallback to Nostr for remaining results
        const remaining = limit - localPubkeys.length;
        const searchFilter = {
            kinds: [0],
            search: query,
            limit: remaining
        };
        
        const events = await withTimeout(
            this.searchPool!.querySync(RelatrService.SEARCH_RELAYS, searchFilter),
            10000
        );
        
        // Extract unique pubkeys not already in local results
        const nostrPubkeys: string[] = [];
        for (const event of events) {
            if (!localPubkeys.includes(event.pubkey)) {
                nostrPubkeys.push(event.pubkey);
                
                // Cache the profile for future use
                try {
                    const profile = JSON.parse(event.content);
                    await this.metadataCache!.set(event.pubkey, {
                        pubkey: event.pubkey,
                        name: profile.name,
                        display_name: profile.display_name,
                        nip05: profile.nip05,
                        lud16: profile.lud16,
                        about: profile.about
                    });
                } catch (error) {
                    // Skip invalid profiles
                }
            }
        }
        
        // Step 4: Merge and calculate trust scores
        const allPubkeys = [...localPubkeys, ...nostrPubkeys];
        const profilesWithScores = await this.calculateProfileScores(
            allPubkeys,
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
                        console.log(`[RelatrService] Background cleanup completed: ${result.totalDeleted} expired entries removed`);
                    }
                }
            } catch (error) {
                // Log error but don't crash the service
                console.error('[RelatrService] Background cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }, 60 * 60 * 1000 * 7); // 1 hour
    }

    /**
     * Sync contact profiles from source pubkey's contact network
     * @private
     */
    private async syncContactProfiles(): Promise<void> {
        if (!this.searchPool || !this.db) return;
        
        const startTime = Date.now();
        const syncKey = `contact_sync:${this.config.defaultSourcePubkey}`;
        const syncInterval = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        
        try {
            // Check if we've synced recently
            const lastSyncResult = this.db.query(
                'SELECT value FROM settings WHERE key = ?'
            ).get(syncKey) as { value: string } | undefined;
            
            if (lastSyncResult) {
                const lastSyncTime = parseInt(lastSyncResult.value);
                const timeSinceLastSync = Date.now() - lastSyncTime;
                
                if (timeSinceLastSync < syncInterval) {
                    const hoursSinceLastSync = Math.floor(timeSinceLastSync / (60 * 60 * 1000));
                    console.log(`[RelatrService] Skipping contact sync - last sync was ${hoursSinceLastSync} hours ago`);
                    return;
                }
            }
            
            console.log('[RelatrService] Starting contact profile sync...');
            
            // 1. Fetch kind 3 (contact list) for source pubkey
            const contactEvents = await this.searchPool.querySync(
                this.config.nostrRelays,
                { kinds: [3], authors: [this.config.defaultSourcePubkey], limit: 1 }
            );
            
            if (!contactEvents.length) {
                console.log('[RelatrService] No contact list found for source pubkey');
                return;
            }
            
            // 2. Parse contacts (p tags)
            const contactPubkeys: string[] = [];
            if (contactEvents[0]?.tags) {
                for (const tag of contactEvents[0].tags) {
                    if (tag && tag[0] === 'p' && tag[1]) {
                        contactPubkeys.push(tag[1]);
                    }
                }
            }
            
            if (!contactPubkeys.length) {
                console.log('[RelatrService] No contacts found in contact list');
                return;
            }
            
            console.log(`[RelatrService] Found ${contactPubkeys.length} contacts, syncing profiles...`);
            
            // 3. Fetch metadata in batches
            const batchSize = 100;
            let synced = 0;
            
            for (let i = 0; i < contactPubkeys.length; i += batchSize) {
                const batch = contactPubkeys.slice(i, i + batchSize);
                const events = await this.searchPool.querySync(
                    this.config.nostrRelays,
                    { kinds: [0], authors: batch as string[] }
                );
                
                // 4. Insert into FTS5 table via metadataCache
                for (const event of events) {
                    try {
                        const profile = JSON.parse(event.content);
                        await this.metadataCache!.set(event.pubkey, {
                            pubkey: event.pubkey,
                            name: profile.name,
                            display_name: profile.display_name,
                            nip05: profile.nip05,
                            lud16: profile.lud16,
                            about: profile.about
                        });
                        synced++;
                    } catch (error) {
                        // Skip invalid profiles
                    }
                }
            }
            
            // Update the last sync time
            const now = Date.now();
            this.db.run(
                'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                [syncKey, now.toString(), now]
            );
            
            console.log(`[RelatrService] Synced ${synced} contact profiles in ${Date.now() - startTime}ms`);
        } catch (error) {
            console.error('[RelatrService] Contact sync error:', error instanceof Error ? error.message : String(error));
        }
    }

    getConfig(): RelatrConfig { return { ...this.config }; }
    isInitialized(): boolean { return this.initialized; }
    getSocialGraph(): SocialGraph | null { return this.socialGraph; }
    getTrustCalculator(): TrustCalculator | null { return this.trustCalculator; }
}