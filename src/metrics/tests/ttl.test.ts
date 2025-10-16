import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MetricsCache } from '../cache/MetricsCache';
import type { ProfileMetrics } from '../types';

describe('TTL Expiration Tests', () => {
    let db: Database;
    let cache: MetricsCache;
    
    beforeAll(async () => {
        // Initialize in-memory database for testing
        db = new Database(':memory:');
        
        // Initialize schema
        const schema = await Bun.file('src/database/schema.sql').text();
        db.run(schema);
        
        // Initialize cache with short TTL for testing
        cache = new MetricsCache(db, {
            defaultTtl: 2, // 2 seconds
            maxEntries: 100,
            cleanupInterval: 0, // Disable periodic cleanup
            enableStats: true,
        });
    });
    
    afterAll(() => {
        cache.destroy();
        db.close();
    });
    
    beforeEach(() => {
        // Reset cache stats
        cache.resetStats();
    });
    
    it('should return cached metrics before TTL expires', async () => {
        const pubkey = 'npub1test1234567890abcdef1234567890abcdef1234567890abcdef';
        const metrics: ProfileMetrics = {
            pubkey,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        // Save to cache
        await cache.saveMetrics(pubkey, metrics);
        
        // Retrieve immediately (should be cached)
        const cached = await cache.getMetrics(pubkey);
        
        expect(cached).toBeDefined();
        expect(cached!.pubkey).toBe(pubkey);
        expect(cached!.nip05Valid).toBe(1.0);
        
        // Check stats
        const stats = cache.getStats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(0);
    });
    
    it('should not return cached metrics after TTL expires', async () => {
        const pubkey = 'npub1test1234567890abcdef1234567890abcdef1234567890abcdef';
        const metrics: ProfileMetrics = {
            pubkey,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        // Save to cache
        await cache.saveMetrics(pubkey, metrics);
        
        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds > 2 second TTL
        
        // Try to retrieve (should be expired)
        const cached = await cache.getMetrics(pubkey);
        
        expect(cached).toBeNull();
        
        // Check stats
        const stats = cache.getStats();
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(1);
    });
    
    it('should handle custom TTL per save operation', async () => {
        const pubkey1 = 'npub1test111111111111111111111111111111111111111111111111';
        const pubkey2 = 'npub1test222222222222222222222222222222222222222222222222';
        
        const metrics1: ProfileMetrics = {
            pubkey: pubkey1,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        const metrics2: ProfileMetrics = {
            pubkey: pubkey2,
            nip05Valid: 0.0,
            lightningAddress: 1.0,
            eventKind10002: 1.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        // Save with different TTLs
        await cache.saveMetrics(pubkey1, metrics1, 1); // 1 second TTL
        await cache.saveMetrics(pubkey2, metrics2, 5); // 5 second TTL
        
        // Wait 2 seconds
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // pubkey1 should be expired, pubkey2 should still be cached
        const cached1 = await cache.getMetrics(pubkey1);
        const cached2 = await cache.getMetrics(pubkey2);
        
        expect(cached1).toBeNull(); // Should be expired
        expect(cached2).toBeDefined(); // Should still be cached
        expect(cached2!.pubkey).toBe(pubkey2);
    });
    
    it('should clean up expired entries', async () => {
        const pubkey = 'npub1test1234567890abcdef1234567890abcdef1234567890abcdef';
        const metrics: ProfileMetrics = {
            pubkey,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        // Save to cache
        await cache.saveMetrics(pubkey, metrics);
        
        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds > 2 second TTL
        
        // Run cleanup
        const cleanedCount = await cache.cleanup();
        
        expect(cleanedCount).toBeGreaterThan(0);
        
        // Try to retrieve (should be null)
        const cached = await cache.getMetrics(pubkey);
        expect(cached).toBeNull();
    });
    
    it('should detect expired metrics', () => {
        const now = Math.floor(Date.now() / 1000);
        
        // Fresh metrics
        const freshMetrics: ProfileMetrics = {
            pubkey: 'test',
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: now,
        };
        
        // Expired metrics (computed 3 hours ago with 1 hour default TTL)
        const expiredMetrics: ProfileMetrics = {
            pubkey: 'test',
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: now - 10800, // 3 hours ago
        };
        
        expect(cache.isExpired(freshMetrics)).toBe(false);
        expect(cache.isExpired(expiredMetrics)).toBe(true);
    });
    
    it('should handle metric-specific expiration checks', async () => {
        const pubkey = 'npub1test1234567890abcdef1234567890abcdef1234567890abcdef';
        const metrics: ProfileMetrics = {
            pubkey,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 0.0,
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        // Save to cache
        await cache.saveMetrics(pubkey, metrics);
        
        // Check specific metric expiration (should not be expired yet)
        const isNip05Expired = await cache.isMetricExpired(pubkey, 'nip05_valid');
        const isLightningExpired = await cache.isMetricExpired(pubkey, 'lightning_address');
        
        expect(isNip05Expired).toBe(false);
        expect(isLightningExpired).toBe(false);
        
        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check again (should be expired now)
        const isNip05ExpiredAfter = await cache.isMetricExpired(pubkey, 'nip05_valid');
        const isLightningExpiredAfter = await cache.isMetricExpired(pubkey, 'lightning_address');
        
        expect(isNip05ExpiredAfter).toBe(true);
        expect(isLightningExpiredAfter).toBe(true);
    });
});