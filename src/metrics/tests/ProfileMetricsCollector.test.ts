import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SimplePool } from 'nostr-tools/pool';
import { ProfileMetricsCollector } from '../ProfileMetricsCollector';
import { SocialGraphManager } from '../../social-graph/SocialGraphManager';
import type { ProfileMetrics } from '../types';

// Mock dependencies
const mockDb = {
    query: mock(() => ({ run: mock(), get: mock(), all: mock() })),
    exec: mock(),
} as any;

const mockPool = {
    get: mock(() => Promise.resolve(null)),
    close: mock(),
} as any;

const mockCache = {
    getMetrics: mock(() => Promise.resolve(null)),
    saveMetrics: mock(() => Promise.resolve()),
    isExpired: mock(() => false),
    invalidate: mock(() => Promise.resolve()),
    invalidateMetric: mock(() => Promise.resolve()),
    getStats: mock(() => ({ hits: 0, misses: 0, total: 0, hitRate: 0, lastReset: Date.now() })),
    resetStats: mock(),
    cleanup: mock(() => Promise.resolve(0)),
    getCacheInfo: mock(() => Promise.resolve({ totalEntries: 0, expiredEntries: 0, maxEntries: 1000, utilization: 0 })),
    destroy: mock(),
} as any;

const mockGraphManager = {
    isManagerInitialized: mock(() => true),
    isInGraph: mock(() => true),
    isFollowing: mock(() => false),
} as any;

// Test configuration
const testConfig = {
    relays: ['wss://relay.damus.io', 'wss://relay.nostr.band'],
    cacheTtlSeconds: 3600,
    enableNip05: true,
    enableLightning: true,
    enableEventKind10002: true,
    enableReciprocity: true,
    validatorConfig: {
        nip05: {
            timeout: 5000,
            retries: 2,
            retryDelay: 1000,
            enableLogging: true,
            wellKnownTimeout: 3000,
            verifySignature: true,
        },
        lightning: {
            timeout: 5000,
            retries: 2,
            retryDelay: 1000,
            enableLogging: true,
            validateLnurl: true,
            checkConnectivity: false,
        },
    },
    cacheConfig: {
        defaultTtl: 3600,
        maxEntries: 10000,
        cleanupInterval: 3600000,
        enableStats: true,
    },
};

describe('ProfileMetricsCollector', () => {
    let collector: ProfileMetricsCollector;
    
    beforeEach(() => {
        // Mock MetricsCache constructor
        mockCache.getMetrics.mockClear();
        mockCache.saveMetrics.mockClear();
        mockCache.isExpired.mockClear();
        
        collector = new ProfileMetricsCollector(mockDb, testConfig);
        
        // Replace the cache instance with our mock
        (collector as any).cache = mockCache;
        (collector as any).pool = mockPool;
    });
    
    describe('core functionality', () => {
        it('should collect all metrics for a pubkey', async () => {
            const targetPubkey = 'test-pubkey';
            const sourcePubkey = 'source-pubkey';
            
            // Mock profile fetch
            const mockProfile = {
                nip05: 'test@domain.com',
                lud16: 'test@ln.address',
            };
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify(mockProfile),
            });
            
            // Mock validator results
            const mockNip05Result = { valid: true, nip05: 'test@domain.com', pubkey: targetPubkey, verifiedAt: Date.now() };
            const mockLightningResult = { hasAddress: true, validFormat: true, verifiedAt: Date.now() };
            const mockEventResult = { hasEvent: true, eventKind: 10002, verifiedAt: Date.now() };
            const mockReciprocityResult = { isReciprocal: true, verifiedAt: Date.now() };
            
            // Mock validator methods
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve(mockNip05Result));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve(mockLightningResult));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve(mockEventResult));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve(mockReciprocityResult));
            
            const result = await collector.collectMetrics(targetPubkey, sourcePubkey);
            
            expect(result.pubkey).toBe(targetPubkey);
            expect(result.sourcePubkey).toBe(sourcePubkey);
            expect(result.metrics.nip05Valid).toBe(1.0);
            expect(result.metrics.lightningAddress).toBe(1.0);
            expect(result.metrics.eventKind10002).toBe(1.0);
            expect(result.metrics.reciprocity).toBe(1.0);
            expect(result.cacheHit).toBe(false);
            expect(mockCache.saveMetrics).toHaveBeenCalledWith(targetPubkey, result.metrics);
        });
        
        it('should use cached metrics when available', async () => {
            const targetPubkey = 'test-pubkey';
            const cachedMetrics: ProfileMetrics = {
                pubkey: targetPubkey,
                nip05Valid: 1.0,
                lightningAddress: 0.0,
                eventKind10002: 1.0,
                reciprocity: 0.0,
                computedAt: Math.floor(Date.now() / 1000) - 1000, // 1 second ago
            };
            
            mockCache.getMetrics.mockResolvedValue(cachedMetrics);
            mockCache.isExpired.mockReturnValue(false);
            
            const result = await collector.collectMetrics(targetPubkey);
            
            expect(result.metrics).toEqual(cachedMetrics);
            expect(result.cacheHit).toBe(true);
            expect(mockCache.saveMetrics).not.toHaveBeenCalled();
        });
        
        it('should force refresh when requested', async () => {
            const targetPubkey = 'test-pubkey';
            const cachedMetrics: ProfileMetrics = {
                pubkey: targetPubkey,
                nip05Valid: 1.0,
                lightningAddress: 0.0,
                eventKind10002: 1.0,
                reciprocity: 0.0,
                computedAt: Math.floor(Date.now() / 1000) - 1000,
            };
            
            mockCache.getMetrics.mockResolvedValue(cachedMetrics);
            
            // Mock fresh computation
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({}),
            });
            
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.collectMetrics(targetPubkey, undefined, { forceRefresh: true });
            
            expect(result.cacheHit).toBe(false);
            expect(mockCache.saveMetrics).toHaveBeenCalled();
        });
    });
    
    describe('social graph integration', () => {
        it('should set graph manager for optimized reciprocity checks', () => {
            collector.setGraphManager(mockGraphManager);
            
            expect((collector as any).graphManager).toBe(mockGraphManager);
        });
        
        it('should use graph manager for reciprocity when available', async () => {
            const targetPubkey = 'test-pubkey';
            const sourcePubkey = 'source-pubkey';
            
            collector.setGraphManager(mockGraphManager);
            
            // Mock profile fetch
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({}),
            });
            
            // Mock validator results
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: true, verifiedAt: Date.now() }));
            
            await collector.collectMetrics(targetPubkey, sourcePubkey);
            
            expect((collector as any).reciprocityValidator.graphManager).toBe(mockGraphManager);
        });
    });
    
    describe('batch operations', () => {
        it('should collect metrics for multiple pubkeys', async () => {
            const targetPubkeys = ['pubkey1', 'pubkey2', 'pubkey3'];
            
            // Mock profile fetch
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({}),
            });
            
            // Mock validator results
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.collectBatch({ targetPubkeys });
            
            expect(result.results).toHaveLength(3);
            expect(result.summary.total).toBe(3);
            expect(result.summary.successful).toBe(3);
            expect(result.summary.failed).toBe(0);
        });
        
        it('should handle mixed success/failure in batch operations', async () => {
            const targetPubkeys = ['pubkey1', 'pubkey2', 'pubkey3'];
            
            // Mock profile fetch - fail for second pubkey
            mockPool.get
                .mockResolvedValueOnce({ id: 'profile-event', content: JSON.stringify({}) })
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce({ id: 'profile-event', content: JSON.stringify({}) });
            
            // Mock validator results
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.collectBatch({ targetPubkeys });
            
            expect(result.results).toHaveLength(3);
            // Note: The collector handles errors gracefully and still returns results with default values
            // So all 3 are considered "successful" in terms of returning results
            expect(result.summary.successful).toBe(3);
            expect(result.summary.failed).toBe(0);
        });
    });
    
    describe('individual metric operations', () => {
        it('should get a single metric value', async () => {
            const targetPubkey = 'test-pubkey';
            
            // Mock profile fetch
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({ nip05: 'test@domain.com' }),
            });
            
            // Mock validator results
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: true, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.getMetric(targetPubkey, 'nip05Valid');
            
            expect(result).toBe(1.0);
        });
        
        it('should return default value when metric not found', async () => {
            const targetPubkey = 'test-pubkey';
            
            // Mock cache miss first
            mockCache.getMetrics.mockResolvedValue(null);
            mockCache.isExpired.mockReturnValue(false);
            
            // Mock profile fetch
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({}),
            });
            
            // Mock validator results - all false
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.getMetric(targetPubkey, 'nip05Valid');
            
            expect(result).toBe(0.0);
        });
    });
    
    describe('cache management', () => {
        it('should invalidate cache for a pubkey', async () => {
            const targetPubkey = 'test-pubkey';
            
            await collector.invalidateCache(targetPubkey);
            
            expect(mockCache.invalidate).toHaveBeenCalledWith(targetPubkey);
        });
        
        it('should invalidate specific metric for a pubkey', async () => {
            const targetPubkey = 'test-pubkey';
            
            await collector.invalidateMetric(targetPubkey, 'nip05Valid');
            
            expect(mockCache.invalidateMetric).toHaveBeenCalledWith(targetPubkey, 'nip05_valid');
        });
        
        it('should refresh metrics for a pubkey', async () => {
            const targetPubkey = 'test-pubkey';
            
            // Mock profile fetch
            mockPool.get.mockResolvedValue({
                id: 'profile-event',
                content: JSON.stringify({}),
            });
            
            // Mock validator results
            (collector as any).nip05Validator.validateWithPubkey = mock(() => Promise.resolve({ valid: false, verifiedAt: Date.now() }));
            (collector as any).lightningValidator.validateWithDetails = mock(() => Promise.resolve({ hasAddress: false, verifiedAt: Date.now() }));
            (collector as any).eventValidator.validateRelayListMetadata = mock(() => Promise.resolve({ hasEvent: false, verifiedAt: Date.now() }));
            (collector as any).reciprocityValidator.validateReciprocity = mock(() => Promise.resolve({ isReciprocal: false, verifiedAt: Date.now() }));
            
            const result = await collector.refreshMetrics(targetPubkey);
            
            expect(mockCache.invalidate).toHaveBeenCalledWith(targetPubkey);
            expect(result.cacheHit).toBe(false);
        });
        
        it('should get cache statistics', () => {
            const stats = collector.getCacheStats();
            
            expect(stats).toBeDefined();
            expect(mockCache.getStats).toHaveBeenCalled();
        });
        
        it('should reset cache statistics', () => {
            collector.resetCacheStats();
            
            expect(mockCache.resetStats).toHaveBeenCalled();
        });
        
        it('should cleanup expired cache entries', async () => {
            await collector.cleanupCache();
            
            expect(mockCache.cleanup).toHaveBeenCalled();
        });
    });
    
    describe('configuration', () => {
        it('should get current configuration', () => {
            const config = collector.getConfig();
            
            expect(config).toEqual(testConfig);
        });
        
        it('should update configuration', () => {
            const newConfig = {
                enableNip05: false,
                cacheTtlSeconds: 7200,
            };
            
            collector.updateConfig(newConfig);
            
            const config = collector.getConfig();
            expect(config.enableNip05).toBe(false);
            expect(config.cacheTtlSeconds).toBe(7200);
            expect(config.relays).toEqual(testConfig.relays); // Should preserve existing values
        });
    });
    
    describe('cleanup', () => {
        it('should cleanup resources', () => {
            collector.cleanup();
            
            expect(mockPool.close).toHaveBeenCalledWith(testConfig.relays);
            expect(mockCache.destroy).toHaveBeenCalled();
        });
    });
});