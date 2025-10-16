import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TrustScoreCalculator } from '../TrustScoreCalculator';
import { DistanceNormalizer } from '../../distance/DistanceNormalizer';
import { ProfileMetricsCollector } from '../../metrics/ProfileMetricsCollector';
import { DefaultWeightingScheme, ProgressiveScheme } from '../WeightingScheme';
import type { MetricInputs } from '../types';

describe('Trust Score Integration', () => {
    let db: Database;
    let calculator: TrustScoreCalculator;
    let distanceNormalizer: DistanceNormalizer;
    let metricsCollector: ProfileMetricsCollector;
    
    beforeEach(async () => {
        // Create an in-memory database for testing
        db = new Database(':memory:');
        
        // Initialize the database schema
        const schemaFile = Bun.file('src/database/schema.sql');
        const schemaContent = await schemaFile.text();
        db.exec(schemaContent);
        
        calculator = new TrustScoreCalculator({ cacheResults: true }, db);
        distanceNormalizer = new DistanceNormalizer();
        
        // Create a minimal ProfileMetricsCollector config for testing
        metricsCollector = new ProfileMetricsCollector(db, {
            relays: ['wss://relay.damus.io'],
            cacheTtlSeconds: 3600,
            enableNip05: true,
            enableLightning: true,
            enableEventKind10002: true,
            enableReciprocity: true,
            validatorConfig: {
                nip05: {
                    timeout: 5000,
                    retries: 3,
                    retryDelay: 1000,
                    enableLogging: false,
                    wellKnownTimeout: 3000,
                    verifySignature: true,
                },
                lightning: {
                    timeout: 5000,
                    retries: 3,
                    retryDelay: 1000,
                    enableLogging: false,
                    validateLnurl: false,
                    checkConnectivity: false,
                },
            },
            cacheConfig: {
                defaultTtl: 3600,
                maxEntries: 1000,
                cleanupInterval: 300000,
                enableStats: true,
            },
        });
    });
    
    afterEach(() => {
        if (db) {
            db.close();
        }
    });

    describe('End-to-End Trust Score Calculation', () => {
        it('should calculate trust score using real metric inputs', async () => {
            // Simulate distance normalization
            const distance = 2; // Social graph distance
            const distanceWeight = distanceNormalizer.normalize(distance);
            
            // Simulate profile metrics
            const profileMetrics = {
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 0.5,
            };
            
            // Combine all metrics
            const inputs: MetricInputs = {
                distanceWeight,
                ...profileMetrics,
            };
            
            // Calculate trust score
            const result = await calculator.calculate(
                inputs,
                'source-pubkey-1234567890abcdef1234567890abcdef12345678',
                'target-pubkey-1234567890abcdef1234567890abcdef12345678'
            );
            
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
            expect(result.metricValues).toEqual(inputs as unknown as Record<string, number>);
            expect(Object.keys(result.metricWeights)).toHaveLength(5);
        });

        it('should handle different distance values correctly', async () => {
            const profileMetrics = {
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 1.0,
                reciprocity: 1.0,
            };
            
            // Test different distances
            const distances = [0, 1, 2, 5, 10];
            const scores: number[] = [];
            
            for (const distance of distances) {
                const inputs: MetricInputs = {
                    distanceWeight: distanceNormalizer.normalize(distance),
                    ...profileMetrics,
                };
                
                const result = await calculator.calculate(inputs);
                scores.push(result.score);
            }
            
            // Scores should decrease as distance increases
            for (let i = 1; i < scores.length; i++) {
                const currentScore = scores[i];
                const previousScore = scores[i - 1];
                if (currentScore !== undefined && previousScore !== undefined) {
                    expect(currentScore).toBeLessThanOrEqual(previousScore);
                }
            }
        });

        it('should work with different weighting schemes', async () => {
            const inputs: MetricInputs = {
                distanceWeight: 0.5,
                nip05Valid: 1.0,
                lightningAddress: 0.0,
                eventKind10002: 1.0,
                reciprocity: 0.5,
            };
            
            // Calculate with default scheme
            const defaultResult = await calculator.calculate(inputs);
            
            // Calculate with progressive scheme
            calculator.setWeightingScheme(ProgressiveScheme);
            const progressiveResult = await calculator.calculate(inputs);
            
            // Results should be different
            expect(defaultResult.score).not.toBe(progressiveResult.score);
            
            // Progressive scheme should emphasize validations more
            if (progressiveResult.metricWeights.nip05Valid !== undefined &&
                defaultResult.metricWeights.nip05Valid !== undefined) {
                expect(progressiveResult.metricWeights.nip05Valid).toBeGreaterThan(
                    defaultResult.metricWeights.nip05Valid
                );
            }
        });

        it('should cache and retrieve trust scores correctly', async () => {
            const sourcePubkey = 'source-pubkey-1234567890abcdef1234567890abcdef12345678';
            const targetPubkey = 'target-pubkey-1234567890abcdef1234567890abcdef12345678';
            
            const inputs: MetricInputs = {
                distanceWeight: 0.8,
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            // First calculation
            const result1 = await calculator.calculate(inputs, sourcePubkey, targetPubkey);
            
            // Second calculation should hit cache
            const result2 = await calculator.calculate(inputs, sourcePubkey, targetPubkey);
            
            expect(result1.score).toBe(result2.score);
            expect(result1.computedAt).toBe(result2.computedAt);
            
            // Check cache stats
            const stats = calculator.getCacheStats();
            expect(stats?.hits).toBeGreaterThan(0);
        });

        it('should generate detailed breakdowns', async () => {
            const inputs: MetricInputs = {
                distanceWeight: 0.6,
                nip05Valid: 1.0,
                lightningAddress: 0.5,
                eventKind10002: 0.0,
                reciprocity: 0.8,
            };
            
            const result = await calculator.calculate(inputs);
            const breakdown = calculator.calculateBreakdown(inputs);
            
            expect(breakdown).toHaveLength(5);
            
            // Check that breakdown contributions sum to the final score
            const totalContribution = breakdown.reduce((sum, m) => sum + m.contribution, 0);
            const totalWeight = breakdown.reduce((sum, m) => sum + m.weight, 0);
            const calculatedScore = totalWeight > 0 ? totalContribution / totalWeight : 0;
            
            expect(calculatedScore).toBeCloseTo(result.score, 5);
        });

        it('should handle edge cases gracefully', async () => {
            // All zeros
            const zeroInputs: MetricInputs = {
                distanceWeight: 0,
                nip05Valid: 0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };
            
            const zeroResult = await calculator.calculate(zeroInputs);
            expect(zeroResult.score).toBe(0);
            
            // All ones
            const perfectInputs: MetricInputs = {
                distanceWeight: 1,
                nip05Valid: 1,
                lightningAddress: 1,
                eventKind10002: 1,
                reciprocity: 1,
            };
            
            const perfectResult = await calculator.calculate(perfectInputs);
            expect(perfectResult.score).toBe(1);
        });

        it('should validate inputs and reject invalid values', async () => {
            const invalidInputs: MetricInputs = {
                distanceWeight: -0.1, // Invalid negative value
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            await expect(calculator.calculate(invalidInputs)).rejects.toThrow('Invalid metric inputs');
        });

        it('should simulate score changes', async () => {
            const baseInputs: MetricInputs = {
                distanceWeight: 0.5,
                nip05Valid: 1.0,
                lightningAddress: 0.0,
                eventKind10002: 0.0,
                reciprocity: 0.5,
            };
            
            const baseScore = calculator.simulate(baseInputs, {});
            
            // Simulate improving distance
            const improvedDistanceScore = calculator.simulate(baseInputs, {
                distanceWeight: 0.8,
            });
            
            expect(improvedDistanceScore).toBeGreaterThan(baseScore);
            
            // Simulate adding NIP-05
            const withNip05Score = calculator.simulate(baseInputs, {
                nip05Valid: 1.0,
            });
            
            expect(withNip05Score).toBeGreaterThanOrEqual(baseScore);
        });

        it('should handle cache invalidation', async () => {
            const sourcePubkey = 'source-pubkey-1234567890abcdef1234567890abcdef12345678';
            const targetPubkey = 'target-pubkey-1234567890abcdef1234567890abcdef12345678';
            
            const inputs: MetricInputs = {
                distanceWeight: 0.8,
                nip05Valid: 1.0,
                lightningAddress: 1.0,
                eventKind10002: 0.0,
                reciprocity: 1.0,
            };
            
            // Calculate and cache
            await calculator.calculate(inputs, sourcePubkey, targetPubkey);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(true);
            
            // Invalidate cache
            await calculator.invalidateCache(sourcePubkey, targetPubkey);
            expect(await calculator.hasCachedScore(sourcePubkey, targetPubkey)).toBe(false);
        });

        it('should work with partial metric data', async () => {
            const partialInputs: Partial<MetricInputs> = {
                distanceWeight: 0.7,
                nip05Valid: 1.0,
                // Other metrics missing
            };
            
            const result = await calculator.calculate(partialInputs as MetricInputs);
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
            
            // Should generate warnings for missing metrics
            const validation = calculator.validateInputs(partialInputs as MetricInputs);
            expect(validation.isValid).toBe(true);
            expect(validation.warnings.length).toBeGreaterThan(0);
        });
    });

    describe('Performance and Scalability', () => {
        it('should handle multiple calculations efficiently', async () => {
            const inputs: MetricInputs = {
                distanceWeight: 0.6,
                nip05Valid: 1.0,
                lightningAddress: 0.5,
                eventKind10002: 0.0,
                reciprocity: 0.8,
            };
            
            const startTime = Date.now();
            
            // Perform multiple calculations
            const promises = [];
            for (let i = 0; i < 100; i++) {
                promises.push(calculator.calculate(inputs));
            }
            
            const results = await Promise.all(promises);
            const endTime = Date.now();
            
            expect(results).toHaveLength(100);
            expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
            
            // All results should be the same
            const firstScore = results[0]?.score;
            if (firstScore === undefined) {
                throw new Error('First result is undefined');
            }
            for (const result of results) {
                expect(result.score).toBe(firstScore);
            }
        });

        it('should handle cache efficiently', async () => {
            const inputs: MetricInputs = {
                distanceWeight: 0.6,
                nip05Valid: 1.0,
                lightningAddress: 0.5,
                eventKind10002: 0.0,
                reciprocity: 0.8,
            };
            
            const sourcePubkey = 'source-pubkey-1234567890abcdef1234567890abcdef12345678';
            
            // Create multiple targets
            const targetPubkeys = [];
            for (let i = 0; i < 50; i++) {
                targetPubkeys.push(`target-pubkey-${i.toString().padStart(64, '0')}`);
            }
            
            // First pass - cache misses
            const startTime1 = Date.now();
            for (const targetPubkey of targetPubkeys) {
                await calculator.calculate(inputs, sourcePubkey, targetPubkey);
            }
            const time1 = Date.now() - startTime1;
            
            // Second pass - cache hits
            const startTime2 = Date.now();
            for (const targetPubkey of targetPubkeys) {
                await calculator.calculate(inputs, sourcePubkey, targetPubkey);
            }
            const time2 = Date.now() - startTime2;
            
            // Cache hits should be faster
            expect(time2).toBeLessThan(time1);
            
            // Check cache statistics
            const stats = calculator.getCacheStats();
            expect(stats?.hits).toBeGreaterThan(40);
            expect(stats?.hitRate).toBeGreaterThan(0.4);
        });
    });

    describe('Real-world Scenarios', () => {
        it('should handle a typical user profile', async () => {
            // Simulate a typical user with good profile validation
            const typicalUser: MetricInputs = {
                distanceWeight: 0.3, // Some social connection
                nip05Valid: 1.0,    // Verified NIP-05
                lightningAddress: 1.0, // Lightning setup
                eventKind10002: 0.0,  // No relay list
                reciprocity: 0.0,     // No mutual follow
            };
            
            const result = await calculator.calculate(typicalUser);
            
            // Should have a decent score due to validations
            expect(result.score).toBeGreaterThanOrEqual(0.4);
            expect(result.score).toBeLessThan(0.8);
        });

        it('should handle a well-connected user', async () => {
            // Simulate a well-connected user
            const wellConnectedUser: MetricInputs = {
                distanceWeight: 0.9, // Very close in social graph
                nip05Valid: 1.0,     // Verified NIP-05
                lightningAddress: 1.0, // Lightning setup
                eventKind10002: 1.0,  // Has relay list
                reciprocity: 1.0,     // Mutual follow
            };
            
            const result = await calculator.calculate(wellConnectedUser);
            
            // Should have a very high score
            expect(result.score).toBeGreaterThan(0.8);
        });

        it('should handle a new/unknown user', async () => {
            // Simulate a new user with minimal profile
            const newUser: MetricInputs = {
                distanceWeight: 0.0, // No social connection
                nip05Valid: 0.0,     // No NIP-05
                lightningAddress: 0.0, // No lightning
                eventKind10002: 0.0,  // No relay list
                reciprocity: 0.0,     // No mutual follow
            };
            
            const result = await calculator.calculate(newUser);
            
            // Should have a very low score
            expect(result.score).toBeLessThan(0.2);
        });
    });
});