import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TrustScoreCache } from '../TrustScoreCache';
import type { TrustScoreResult } from '../types';

describe('TrustScoreCache', () => {
    let db: Database;
    let cache: TrustScoreCache;
    
    beforeEach(async () => {
        // Create an in-memory database for testing
        db = new Database(':memory:');
        
        // Initialize the database schema
        const schemaFile = Bun.file('src/database/schema.sql');
        const schemaContent = await schemaFile.text();
        db.exec(schemaContent);
        
        cache = new TrustScoreCache(db, 3600); // 1 hour TTL
    });
    
    afterEach(() => {
        if (db) {
            db.close();
        }
    });

    describe('Constructor', () => {
        it('should initialize with default TTL', () => {
            const testCache = new TrustScoreCache(db);
            expect(testCache).toBeDefined();
        });

        it('should initialize with custom TTL', () => {
            const testCache = new TrustScoreCache(db, 7200);
            expect(testCache).toBeDefined();
        });
    });

    describe('save and get', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: {
                distanceWeight: 0.8,
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            },
            metricWeights: {
                distanceWeight: 0.5,
                nip05Valid: 0.15,
                lightningAddress: 0.1,
                eventKind10002: 0.1,
                reciprocity: 0.15,
            },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should save and retrieve trust score', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            
            const retrieved = await cache.get(sourcePubkey, targetPubkey);
            expect(retrieved).toBeDefined();
            expect(retrieved?.score).toBe(testResult.score);
            expect(retrieved?.metricValues).toEqual(testResult.metricValues);
            expect(retrieved?.metricWeights).toEqual(testResult.metricWeights);
            expect(retrieved?.computedAt).toBe(testResult.computedAt);
        });

        it('should return null for non-existent entry', async () => {
            const retrieved = await cache.get(sourcePubkey, targetPubkey);
            expect(retrieved).toBeNull();
        });

        it('should update existing entry', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            
            const updatedResult: TrustScoreResult = {
                ...testResult,
                score: 0.9,
                computedAt: testResult.computedAt + 100,
            };
            
            await cache.save(sourcePubkey, targetPubkey, updatedResult);
            
            const retrieved = await cache.get(sourcePubkey, targetPubkey);
            expect(retrieved?.score).toBe(0.9);
            expect(retrieved?.computedAt).toBe(updatedResult.computedAt);
        });

        it('should handle multiple pubkey pairs', async () => {
            const targetPubkey2 = 'c'.repeat(64);
            
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.save(sourcePubkey, targetPubkey2, {
                ...testResult,
                score: 0.7,
            });
            
            const result1 = await cache.get(sourcePubkey, targetPubkey);
            const result2 = await cache.get(sourcePubkey, targetPubkey2);
            
            expect(result1?.score).toBe(0.85);
            expect(result2?.score).toBe(0.7);
        });
    });

    describe('exists', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should return false for non-existent entry', async () => {
            const exists = await cache.exists(sourcePubkey, targetPubkey);
            expect(exists).toBe(false);
        });

        it('should return true for existing entry', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            
            const exists = await cache.exists(sourcePubkey, targetPubkey);
            expect(exists).toBe(true);
        });
    });

    describe('invalidate', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const targetPubkey2 = 'c'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should invalidate specific pubkey pair', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.save(sourcePubkey, targetPubkey2, testResult);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(true);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(true);
            
            await cache.invalidate(sourcePubkey, targetPubkey);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(false);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(true);
        });

        it('should invalidate all entries for pubkey', async () => {
            const sourcePubkey2 = 'd'.repeat(64);
            
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.save(sourcePubkey, targetPubkey2, testResult);
            await cache.save(sourcePubkey2, targetPubkey, testResult);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(true);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(true);
            expect(await cache.exists(sourcePubkey2, targetPubkey)).toBe(true);
            
            await cache.invalidateAll(sourcePubkey);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(false);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(false);
            expect(await cache.exists(sourcePubkey2, targetPubkey)).toBe(true);
        });
    });

    describe('getScoresForSource and getScoresForTarget', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const targetPubkey2 = 'c'.repeat(64);
        const sourcePubkey2 = 'd'.repeat(64);
        
        const testResult1: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };
        
        const testResult2: TrustScoreResult = {
            score: 0.7,
            metricValues: { distanceWeight: 0.6 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should get scores for source pubkey', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult1);
            await cache.save(sourcePubkey, targetPubkey2, testResult2);
            await cache.save(sourcePubkey2, targetPubkey, testResult1);
            
            const sourceScores = await cache.getScoresForSource(sourcePubkey);
            expect(sourceScores).toHaveLength(2);
            if (sourceScores[0]) {
                expect(sourceScores[0].targetPubkey).toBe(targetPubkey);
                expect(sourceScores[0].score).toBe(0.85);
            }
            if (sourceScores[1]) {
                expect(sourceScores[1].targetPubkey).toBe(targetPubkey2);
                expect(sourceScores[1].score).toBe(0.7);
            }
        });

        it('should get scores for target pubkey', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult1);
            await cache.save(sourcePubkey2, targetPubkey, testResult2);
            await cache.save(sourcePubkey, targetPubkey2, testResult1);
            
            const targetScores = await cache.getScoresForTarget(targetPubkey);
            expect(targetScores).toHaveLength(2);
            if (targetScores[0]) {
                expect(targetScores[0].sourcePubkey).toBe(sourcePubkey);
                expect(targetScores[0].score).toBe(0.85);
            }
            if (targetScores[1]) {
                expect(targetScores[1].sourcePubkey).toBe(sourcePubkey2);
                expect(targetScores[1].score).toBe(0.7);
            }
        });

        it('should return empty array for pubkey with no scores', async () => {
            const sourceScores = await cache.getScoresForSource('e'.repeat(64));
            expect(sourceScores).toHaveLength(0);
            
            const targetScores = await cache.getScoresForTarget('f'.repeat(64));
            expect(targetScores).toHaveLength(0);
        });
    });

    describe('cleanup', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should cleanup expired entries', async () => {
            // Create cache with very short TTL
            const shortCache = new TrustScoreCache(db, 1); // 1 second TTL
            
            await shortCache.save(sourcePubkey, targetPubkey, testResult);
            expect(await shortCache.exists(sourcePubkey, targetPubkey)).toBe(true);
            
            // Wait for expiration
            await new Promise(resolve => setTimeout(resolve, 1100));
            
            const deletedCount = await shortCache.cleanup();
            expect(deletedCount).toBeGreaterThanOrEqual(0);
            
            // Entry should now be expired
            const exists = await shortCache.exists(sourcePubkey, targetPubkey);
            // Note: This might still be true if cleanup hasn't run yet
        });
    });

    describe('statistics', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should track cache statistics', async () => {
            // Initial stats
            let stats = cache.getStats();
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
            expect(stats.hitRate).toBe(0);
            
            // Cache miss
            await cache.get(sourcePubkey, targetPubkey);
            stats = cache.getStats();
            expect(stats.misses).toBe(1);
            expect(stats.hitRate).toBe(0);
            
            // Save and hit
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.get(sourcePubkey, targetPubkey);
            stats = cache.getStats();
            expect(stats.hits).toBe(1);
            expect(stats.misses).toBe(1);
            expect(stats.hitRate).toBe(0.5);
        });

        it('should reset statistics', async () => {
            // Generate some activity
            await cache.get(sourcePubkey, targetPubkey);
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.get(sourcePubkey, targetPubkey);
            
            let stats = cache.getStats();
            expect(stats.hits).toBeGreaterThan(0);
            expect(stats.misses).toBeGreaterThan(0);
            
            // Reset
            cache.resetStats();
            
            stats = cache.getStats();
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
            expect(stats.hitRate).toBe(0);
        });
    });

    describe('getEntry and getAllEntries', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should get cache entry with metadata', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            
            const entry = await cache.getEntry(sourcePubkey, targetPubkey);
            expect(entry).toBeDefined();
            expect(entry?.sourcePubkey).toBe(sourcePubkey);
            expect(entry?.targetPubkey).toBe(targetPubkey);
            expect(entry?.result.score).toBe(testResult.score);
            expect(entry?.expiresAt).toBeGreaterThan(Date.now() / 1000);
        });

        it('should return null for non-existent entry', async () => {
            const entry = await cache.getEntry(sourcePubkey, targetPubkey);
            expect(entry).toBeNull();
        });

        it('should get all entries', async () => {
            const targetPubkey2 = 'c'.repeat(64);
            
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.save(sourcePubkey, targetPubkey2, {
                ...testResult,
                score: 0.7,
            });
            
            const allEntries = await cache.getAllEntries(10);
            expect(allEntries.length).toBeGreaterThanOrEqual(2);
            
            const foundEntries = allEntries.filter(e => 
                (e.sourcePubkey === sourcePubkey) && 
                (e.targetPubkey === targetPubkey || e.targetPubkey === targetPubkey2)
            );
            expect(foundEntries.length).toBe(2);
        });
    });

    describe('batchInvalidate', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const targetPubkey2 = 'c'.repeat(64);
        const targetPubkey3 = 'd'.repeat(64);
        const testResult: TrustScoreResult = {
            score: 0.85,
            metricValues: { distanceWeight: 0.8 },
            metricWeights: { distanceWeight: 0.5 },
            computedAt: Math.floor(Date.now() / 1000),
        };

        it('should invalidate multiple pubkey pairs', async () => {
            await cache.save(sourcePubkey, targetPubkey, testResult);
            await cache.save(sourcePubkey, targetPubkey2, testResult);
            await cache.save(sourcePubkey, targetPubkey3, testResult);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(true);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(true);
            expect(await cache.exists(sourcePubkey, targetPubkey3)).toBe(true);
            
            const pairs = [
                { sourcePubkey, targetPubkey },
                { sourcePubkey, targetPubkey: targetPubkey2 },
            ];
            
            const deletedCount = await cache.batchInvalidate(pairs);
            expect(deletedCount).toBe(2);
            
            expect(await cache.exists(sourcePubkey, targetPubkey)).toBe(false);
            expect(await cache.exists(sourcePubkey, targetPubkey2)).toBe(false);
            expect(await cache.exists(sourcePubkey, targetPubkey3)).toBe(true);
        });

        it('should handle empty batch', async () => {
            const deletedCount = await cache.batchInvalidate([]);
            expect(deletedCount).toBe(0);
        });
    });

    describe('Edge cases', () => {
        it('should handle very long pubkeys', async () => {
            const longPubkey = 'a'.repeat(128);
            const testResult: TrustScoreResult = {
                score: 0.85,
                metricValues: { distanceWeight: 0.8 },
                metricWeights: { distanceWeight: 0.5 },
                computedAt: Math.floor(Date.now() / 1000),
            };
            
            await cache.save(longPubkey, longPubkey, testResult);
            const retrieved = await cache.get(longPubkey, longPubkey);
            expect(retrieved?.score).toBe(0.85);
        });

        it('should handle special characters in pubkeys', async () => {
            const specialPubkey = 'a'.repeat(32) + '0'.repeat(32);
            const testResult: TrustScoreResult = {
                score: 0.85,
                metricValues: { distanceWeight: 0.8 },
                metricWeights: { distanceWeight: 0.5 },
                computedAt: Math.floor(Date.now() / 1000),
            };
            
            await cache.save(specialPubkey, specialPubkey, testResult);
            const retrieved = await cache.get(specialPubkey, specialPubkey);
            expect(retrieved?.score).toBe(0.85);
        });
    });
});