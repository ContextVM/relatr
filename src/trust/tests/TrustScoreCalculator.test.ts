import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TrustScoreCalculator } from '../TrustScoreCalculator';
import { DefaultWeightingScheme, ConservativeScheme, getWeightingScheme } from '../WeightingScheme';
import type { MetricInputs, TrustScoreConfig } from '../types';

describe('TrustScoreCalculator', () => {
    let db: Database;
    let calculator: TrustScoreCalculator;
    
    beforeEach(async () => {
        // Create an in-memory database for testing
        db = new Database(':memory:');
        
        // Initialize the database schema
        const schemaFile = await Bun.file('src/database/schema.sql').text();
        db.run(schemaFile);
        
        calculator = new TrustScoreCalculator({ cacheResults: true }, db);
    });
    
    afterEach(() => {
        if (db) {
            db.close();
        }
    });

    describe('Constructor', () => {
        it('should initialize with default weighting scheme', () => {
            const calc = new TrustScoreCalculator();
            const scheme = calc.getWeightingScheme();
            expect(scheme.name).toBe('default');
        });

        it('should initialize with custom weighting scheme', () => {
            const config: TrustScoreConfig = {
                weightingScheme: ConservativeScheme,
            };
            const calc = new TrustScoreCalculator(config);
            const scheme = calc.getWeightingScheme();
            expect(scheme.name).toBe('conservative');
        });

        it('should initialize with caching enabled when database provided', () => {
            const calc = new TrustScoreCalculator({ cacheResults: true }, db);
            const stats = calc.getCacheStats();
            expect(stats).toBeDefined();
        });

        it('should not initialize with caching when no database provided', () => {
            const calc = new TrustScoreCalculator({ cacheResults: true });
            const stats = calc.getCacheStats();
            expect(stats).toBeNull();
        });

        it('should throw error for invalid weighting scheme', () => {
            const invalidScheme = {
                name: '',
                version: 'v1',
                metrics: {},
            };
            
            expect(() => {
                new TrustScoreCalculator({ weightingScheme: invalidScheme });
            }).toThrow('Invalid weighting scheme');
        });
    });

    describe('calculate', () => {
        const validInputs: MetricInputs = {
            distanceWeight: 0.8,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 1.0,
        };

        it('should calculate trust score with all metrics', async () => {
            const result = await calculator.calculate(validInputs);
            
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
            expect(result.metricValues).toEqual(validInputs as unknown as Record<string, number>);
            expect(result.computedAt).toBeGreaterThan(0);
        });

        it('should calculate expected score for default scheme', async () => {
            const result = await calculator.calculate(validInputs);
            
            // Expected: (0.8*0.5 + 1.0*0.15 + 1.0*0.1 + 0.0*0.1 + 1.0*0.15) / 1.0
            // = (0.4 + 0.15 + 0.1 + 0 + 0.15) / 1.0 = 0.8
            expect(result.score).toBeCloseTo(0.8, 3);
        });

        it('should calculate different scores with different schemes', async () => {
            const conservativeCalc = new TrustScoreCalculator(
                { weightingScheme: ConservativeScheme },
                db
            );
            
            const defaultResult = await calculator.calculate(validInputs);
            const conservativeResult = await conservativeCalc.calculate(validInputs);
            
            expect(conservativeResult.score).not.toBe(defaultResult.score);
        });

        it('should handle partial metrics', async () => {
            const partialInputs: MetricInputs = {
                distanceWeight: 0.5,
                nip05Valid: 1.0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };
            
            const result = await calculator.calculate(partialInputs);
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
        });

        it('should validate input values', async () => {
            const invalidInputs: MetricInputs = {
                distanceWeight: -0.1, // Invalid: negative value
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            await expect(calculator.calculate(invalidInputs)).rejects.toThrow('Invalid metric inputs');
        });

        it('should validate input range', async () => {
            const invalidInputs: MetricInputs = {
                distanceWeight: 1.5, // Invalid: > 1.0
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            await expect(calculator.calculate(invalidInputs)).rejects.toThrow('Invalid metric inputs');
        });

        it('should handle infinite values', async () => {
            const invalidInputs: MetricInputs = {
                distanceWeight: Infinity,
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            await expect(calculator.calculate(invalidInputs)).rejects.toThrow('Invalid metric inputs');
        });

        it('should cache results when caching enabled', async () => {
            const sourcePubkey = 'a'.repeat(64);
            const targetPubkey = 'b'.repeat(64);
            
            // First calculation
            const result1 = await calculator.calculate(
                validInputs,
                sourcePubkey,
                targetPubkey
            );
            
            // Second calculation should hit cache
            const result2 = await calculator.calculate(
                validInputs,
                sourcePubkey,
                targetPubkey
            );
            
            expect(result1.score).toBe(result2.score);
            expect(result1.computedAt).toBe(result2.computedAt);
            
            const stats = calculator.getCacheStats();
            expect(stats?.hits).toBeGreaterThan(0);
        });

        it('should bypass cache when forceRefresh is true', async () => {
            const sourcePubkey = 'a'.repeat(64);
            const targetPubkey = 'b'.repeat(64);
            
            // First calculation
            const result1 = await calculator.calculate(
                validInputs,
                sourcePubkey,
                targetPubkey
            );
            
            // Wait a bit to ensure different timestamp
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Second calculation with force refresh and different inputs
            const differentInputs = { ...validInputs, distanceWeight: 0.7 };
            const result2 = await calculator.calculate(
                differentInputs,
                sourcePubkey,
                targetPubkey,
                { forceRefresh: true }
            );
            
            expect(result1.score).not.toBe(result2.score);
            expect(result2.computedAt).toBeGreaterThanOrEqual(result1.computedAt);
        });

        it('should not cache when no pubkeys provided', async () => {
            const result = await calculator.calculate(validInputs);
            expect(result.score).toBeGreaterThanOrEqual(0);
            
            const stats = calculator.getCacheStats();
            expect(stats?.hits).toBe(0);
        });
    });

    describe('validateInputs', () => {
        it('should validate correct inputs', () => {
            const validInputs: MetricInputs = {
                distanceWeight: 0.5,
                nip05Valid: 1.0,
                lightningAddress: 0.0,
                eventKind10002: 1.0,
                reciprocity: 0.5,
            };
            
            const validation = calculator.validateInputs(validInputs);
            expect(validation.isValid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        it('should detect empty inputs', () => {
            const emptyInputs: Partial<MetricInputs> = {};
            
            const validation = calculator.validateInputs(emptyInputs as MetricInputs);
            expect(validation.isValid).toBe(false);
            expect(validation.errors).toContain('No metric values provided');
        });

        it('should detect out of range values', () => {
            const invalidInputs: MetricInputs = {
                distanceWeight: -0.1,
                nip05Valid: 1.5,
                lightningAddress: 0.0,
                eventKind10002: 1.0,
                reciprocity: 0.5,
            };
            
            const validation = calculator.validateInputs(invalidInputs);
            expect(validation.isValid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
        });

        it('should generate warnings for missing metrics', () => {
            const partialInputs: Partial<MetricInputs> = {
                distanceWeight: 0.5,
                nip05Valid: 0,
                // lightningAddress is missing
                // eventKind10002 is missing
                // reciprocity is missing
            };
            
            const validation = calculator.validateInputs(partialInputs as MetricInputs);
            expect(validation.isValid).toBe(true);
            expect(validation.warnings.length).toBeGreaterThan(0);
        });
    });

    describe('setWeightingScheme and getWeightingScheme', () => {
        it('should get current weighting scheme', () => {
            const scheme = calculator.getWeightingScheme();
            expect(scheme.name).toBe('default');
        });

        it('should set new weighting scheme', () => {
            const newScheme = getWeightingScheme('conservative');
            calculator.setWeightingScheme(newScheme);
            
            const currentScheme = calculator.getWeightingScheme();
            expect(currentScheme.name).toBe('conservative');
        });

        it('should reject invalid weighting scheme', () => {
            const invalidScheme = {
                name: 'invalid',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: -0.5, exponent: 1.0, enabled: true },
                },
            };
            
            expect(() => {
                calculator.setWeightingScheme(invalidScheme);
            }).toThrow('Invalid weighting scheme');
        });
    });

    describe('calculateBreakdown', () => {
        const validInputs: MetricInputs = {
            distanceWeight: 0.8,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 1.0,
        };

        it('should generate breakdown for all metrics', () => {
            const breakdown = calculator.calculateBreakdown(validInputs);
            
            expect(breakdown).toHaveLength(5);
            
            // Check that metrics are sorted by contribution
            for (let i = 1; i < breakdown.length; i++) {
                const prevMetric = breakdown[i-1];
                const currMetric = breakdown[i];
                if (prevMetric && currMetric) {
                    expect(prevMetric.contribution).toBeGreaterThanOrEqual(currMetric.contribution);
                }
            }
        });

        it('should calculate contributions correctly', () => {
            const breakdown = calculator.calculateBreakdown(validInputs);
            const distanceMetric = breakdown.find(m => m.metric === 'distanceWeight');
            
            if (distanceMetric) {
                expect(distanceMetric.value).toBe(0.8);
                expect(distanceMetric.weight).toBe(0.5);
                expect(distanceMetric.transformedValue).toBe(0.8);
                expect(distanceMetric.contribution).toBe(0.4);
            }
        });

        it('should handle partial inputs', () => {
            const partialInputs: MetricInputs = {
                distanceWeight: 0.8,
                nip05Valid: 1.0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };
            
            const breakdown = calculator.calculateBreakdown(partialInputs);
            expect(breakdown.length).toBeGreaterThan(0);
            expect(breakdown.length).toBeLessThanOrEqual(5);
        });
    });

    describe('simulate', () => {
        const baseInputs: MetricInputs = {
            distanceWeight: 0.5,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 1.0,
        };

        it('should simulate score with variations', () => {
            const variations = { distanceWeight: 0.8 };
            const simulatedScore = calculator.simulate(baseInputs, variations);
            
            expect(simulatedScore).toBeGreaterThanOrEqual(0);
            expect(simulatedScore).toBeLessThanOrEqual(1);
        });

        it('should handle empty variations', () => {
            const simulatedScore = calculator.simulate(baseInputs, {});
            const originalScore = calculator.simulate(baseInputs, {});
            
            expect(simulatedScore).toBe(originalScore);
        });
    });

    describe('Cache management', () => {
        const sourcePubkey = 'a'.repeat(64);
        const targetPubkey = 'b'.repeat(64);
        const validInputs: MetricInputs = {
            distanceWeight: 0.8,
            nip05Valid: 1.0,
            lightningAddress: 1.0,
            eventKind10002: 0.0,
            reciprocity: 1.0,
        };

        it('should check if cached score exists', async () => {
            // Initially no cache
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(false);
            
            // Calculate and cache
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            
            // Now should exist
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(true);
        });

        it('should get cached score', async () => {
            // Calculate and cache
            const originalResult = await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            
            // Get from cache
            const cachedResult = await calculator.getCachedScore(sourcePubkey, targetPubkey);
            
            expect(cachedResult).toBeDefined();
            expect(cachedResult?.score).toBe(originalResult.score);
            expect(cachedResult?.computedAt).toBe(originalResult.computedAt);
        });

        it('should invalidate cache for pubkey pair', async () => {
            // Calculate and cache
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(true);
            
            // Invalidate
            await calculator.invalidateCache(sourcePubkey, targetPubkey);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(false);
        });

        it('should invalidate all cache for pubkey', async () => {
            const targetPubkey2 = 'c'.repeat(64);
            
            // Calculate and cache multiple entries
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey2);
            
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(true);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey2)).toBe(true);
            
            // Invalidate all for source pubkey
            await calculator.invalidateAllCache(sourcePubkey);
            
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(false);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey2)).toBe(false);
        });

        it('should reset cache statistics', async () => {
            // Generate some cache activity
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            await calculator.calculate(validInputs, sourcePubkey, targetPubkey);
            
            let stats = calculator.getCacheStats();
            expect(stats?.hits).toBeGreaterThan(0);
            
            // Reset stats
            calculator.resetCacheStats();
            
            stats = calculator.getCacheStats();
            expect(stats?.hits).toBe(0);
            expect(stats?.misses).toBe(0);
        });

        it('should cleanup expired entries', async () => {
            // This test would need to manipulate time or use very short TTL
            // For now, just ensure the method exists and doesn't error
            const deletedCount = await calculator.cleanupCache();
            expect(typeof deletedCount).toBe('number');
        });
    });

    describe('Edge cases', () => {
        it('should handle all zero metrics', async () => {
            const zeroInputs: MetricInputs = {
                distanceWeight: 0,
                nip05Valid: 0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };
            
            const result = await calculator.calculate(zeroInputs);
            expect(result.score).toBe(0);
        });

        it('should handle all perfect metrics', async () => {
            const perfectInputs: MetricInputs = {
                distanceWeight: 1,
                nip05Valid: 1,
                lightningAddress: 1,
                eventKind10002: 1,
                reciprocity: 1,
            };
            
            const result = await calculator.calculate(perfectInputs);
            expect(result.score).toBe(1);
        });

        it('should handle calculator without cache', () => {
            const noCacheCalc = new TrustScoreCalculator();
            
            expect(noCacheCalc.getCacheStats()).toBeNull();
            expect(async () => await noCacheCalc.invalidateCache('a', 'b')).not.toThrow();
            expect(async () => await noCacheCalc.invalidateAllCache('a')).not.toThrow();
        });
    });
});