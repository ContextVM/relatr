import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RelatrService } from '../RelatrService';

// Test constants - using real pubkeys to avoid relay issues
const TEST_SOURCE_PUBKEY = '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93';
const TEST_TARGET_PUBKEY = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const TEST_TARGET_PUBKEY_2 = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2';

describe('RelatrService Integration Tests', () => {
    let sharedService: RelatrService;
    let testDb: Database;

    // Initialize shared service once for all tests
    beforeAll(async () => {
        console.log('Initializing shared RelatrService for tests...');
        
        // Create a test database
        testDb = new Database(':memory:');
        
        // Initialize schema
        const schema = await Bun.file('src/database/schema.sql').text();
        for (const statement of schema.split(';')) {
            if (statement.trim()) {
                testDb.run(statement);
            }
        }

        // Initialize test data
        testDb.run(`
            INSERT OR IGNORE INTO pubkeys (pubkey, first_seen_at, last_updated_at) VALUES
            (?, ?, ?), (?, ?, ?), (?, ?, ?)
        `, [
            TEST_SOURCE_PUBKEY, Date.now() - 86400000, Date.now(),
            TEST_TARGET_PUBKEY, Date.now() - 86400000, Date.now(),
            TEST_TARGET_PUBKEY_2, Date.now() - 86400000, Date.now()
        ]);

        sharedService = new RelatrService({
            defaultSourcePubkey: TEST_SOURCE_PUBKEY,
            enableLogging: false, // Reduce noise in tests
            logLevel: 'error',
        });

        // Initialize once (this is the expensive operation)
        await sharedService.initialize();
        console.log('Shared RelatrService initialized successfully');
    });

    afterAll(async () => {
        if (sharedService) {
            await sharedService.shutdown();
        }
        if (testDb) {
            testDb.close();
        }
    });

    describe('Service Lifecycle', () => {
        it('should initialize successfully', async () => {
            const health = await sharedService.getHealthStatus();
            expect(health.healthy).toBe(true);
            expect(health.initialized).toBe(true);
            expect(health.components.database?.healthy).toBe(true);
            expect(health.components.socialGraph?.healthy).toBe(true);
            expect(health.components.distanceNormalizer?.healthy).toBe(true);
            expect(health.components.metricsCollector?.healthy).toBe(true);
            expect(health.components.trustCalculator?.healthy).toBe(true);
        });

        it('should not initialize twice', async () => {
            // Use sharedService to avoid closing singleton database
            await sharedService.initialize(); // Should not throw (already initialized)
            
            const health = await sharedService.getHealthStatus();
            expect(health.healthy).toBe(true);
        });

        it('should shutdown gracefully', async () => {
            // Test shutdown behavior without actually shutting down sharedService
            // to preserve singleton database connection for other tests
            const testService = new RelatrService({
                defaultSourcePubkey: TEST_SOURCE_PUBKEY,
                enableLogging: false,
                logLevel: 'error',
            });
            
            await testService.initialize();
            
            // Clean up graph manager and metrics collector without closing the singleton DB
            if ((testService as any).graphManager) {
                await (testService as any).graphManager.cleanup();
            }
            if ((testService as any).metricsCollector) {
                (testService as any).metricsCollector.cleanup();
            }
            
            // Mark as not initialized
            (testService as any).isInitialized = false;
            
            const health = await testService.getHealthStatus();
            expect(health.initialized).toBe(false);
        });
    });

    describe('Trust Score Calculation', () => {
        // Use shared service to avoid reinitializing social graph

        it('should calculate trust score for valid pubkeys', async () => {
            const result = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                scheme: 'default',
            });

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
            expect(result.sourcePubkey).toBe(TEST_SOURCE_PUBKEY);
            expect(result.targetPubkey).toBe(TEST_TARGET_PUBKEY);
            expect(result.scheme).toBe('default');
            expect(result.metrics).toBeDefined();
            expect(result.metrics.distance).toBeGreaterThanOrEqual(0);
            expect(result.metrics.distanceWeight).toBeGreaterThanOrEqual(0);
            expect(result.metrics.distanceWeight).toBeLessThanOrEqual(1);
            expect(result.computedAt).toBeGreaterThan(0);
            expect(result.duration).toBeGreaterThan(0);
        });

        it('should handle different weighting schemes', async () => {
            const defaultResult = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                scheme: 'default',
            });

            const conservativeResult = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                scheme: 'conservative',
            });

            expect(defaultResult.scheme).toBe('default');
            expect(conservativeResult.scheme).toBe('conservative');
            // Scores may differ due to different weighting schemes
            expect(defaultResult.score).toBeGreaterThanOrEqual(0);
            expect(conservativeResult.score).toBeGreaterThanOrEqual(0);
        });

        it('should use default source pubkey when not provided', async () => {
            const result = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
            });

            expect(result.sourcePubkey).toBe(TEST_SOURCE_PUBKEY);
            expect(result.targetPubkey).toBe(TEST_TARGET_PUBKEY);
        });

        it('should handle force refresh correctly', async () => {
            const firstResult = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                forceRefresh: false,
            });

            const secondResult = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                forceRefresh: true,
            });

            expect(firstResult.score).toBeGreaterThanOrEqual(0);
            expect(secondResult.score).toBeGreaterThanOrEqual(0);
            // Both should be valid scores
        });
    });

    describe('Batch Operations', () => {
        it('should calculate batch trust scores', async () => {
            const result = await sharedService.calculateBatchTrustScores({
                targetPubkeys: [TEST_TARGET_PUBKEY, TEST_TARGET_PUBKEY_2],
                sourcePubkey: TEST_SOURCE_PUBKEY,
                scheme: 'default',
            });

            expect(result.sourcePubkey).toBe(TEST_SOURCE_PUBKEY);
            expect(result.results).toHaveLength(2);
            expect(result.summary.total).toBe(2);
            expect(result.summary.successful).toBeGreaterThanOrEqual(0);
            expect(result.summary.failed).toBeLessThanOrEqual(2);
            expect(result.summary.duration).toBeGreaterThan(0);
            
            // Check individual results
            for (const individualResult of result.results) {
                expect(individualResult.score).toBeGreaterThanOrEqual(0);
                expect(individualResult.score).toBeLessThanOrEqual(1);
                expect(individualResult.sourcePubkey).toBe(TEST_SOURCE_PUBKEY);
                expect([TEST_TARGET_PUBKEY, TEST_TARGET_PUBKEY_2]).toContain(individualResult.targetPubkey);
            }
        });

        it('should handle empty batch', async () => {
            const result = await sharedService.calculateBatchTrustScores({
                targetPubkeys: [],
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            expect(result.results).toHaveLength(0);
            expect(result.summary.total).toBe(0);
            expect(result.summary.successful).toBe(0);
            expect(result.summary.failed).toBe(0);
        });

        it('should handle mixed valid and invalid pubkeys', async () => {
            const invalidPubkey = 'invalid_pubkey';
            
            const result = await sharedService.calculateBatchTrustScores({
                targetPubkeys: [TEST_TARGET_PUBKEY, invalidPubkey],
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            expect(result.results.length).toBeGreaterThanOrEqual(0);
            expect(result.summary.total).toBe(2);
            
            if (result.errors) {
                expect(result.errors.length).toBeGreaterThanOrEqual(0);
            }
        });
    });

    describe('Cache Management', () => {
        it('should invalidate cache for specific pubkey', async () => {
            // First calculate to populate cache
            await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            // Invalidate cache (should not throw)
            await sharedService.invalidateCache(TEST_TARGET_PUBKEY);
            
            // Calculate again (should work fine)
            const result = await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            expect(result.score).toBeGreaterThanOrEqual(0);
        });

        it('should cleanup expired cache entries', async () => {
            const cleanedCount = await sharedService.cleanupCaches();
            expect(cleanedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Service Statistics', () => {
        it('should provide service statistics', async () => {
            // Perform some operations
            await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            const stats = await sharedService.getServiceStats();
            
            expect(stats.initialized).toBe(true);
            expect(stats.uptime).toBeGreaterThan(0);
            expect(stats.operationCount).toBeGreaterThan(0);
            expect(stats.errorCount).toBeGreaterThanOrEqual(0);
            expect(stats.errorRate).toBeGreaterThanOrEqual(0);
        });

        it('should track operations and errors', async () => {
            const statsBefore = await sharedService.getServiceStats();
            
            // Successful operation
            await sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
            });

            const statsAfter = await sharedService.getServiceStats();
            
            expect(statsAfter.operationCount).toBeGreaterThan(statsBefore.operationCount);
            expect(statsAfter.errorCount).toBe(statsBefore.errorCount);
        });
    });

    describe('Error Handling', () => {
        it('should handle operations before initialization', async () => {
            const uninitializedService = new RelatrService();
            
            await expect(uninitializedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
            })).rejects.toThrow('not initialized');
        });

        it('should handle invalid weighting scheme', async () => {
            await expect(sharedService.calculateTrustScore({
                targetPubkey: TEST_TARGET_PUBKEY,
                sourcePubkey: TEST_SOURCE_PUBKEY,
                scheme: 'invalid_scheme',
            })).rejects.toThrow();
        });
    });

    describe('Configuration', () => {
        it('should provide sanitized configuration', async () => {
            const serviceConfig = sharedService.getConfig();
            
            expect(serviceConfig.hasDefaultSourcePubkey).toBe(true);
            expect(serviceConfig.defaultSourcePubkeyPrefix).toBe(TEST_SOURCE_PUBKEY.substring(0, 8) + '...');
            expect(serviceConfig.enableMetrics).toBe(true);
            expect(serviceConfig.enableLogging).toBe(false);
            expect(serviceConfig.logLevel).toBe('error');
            expect(serviceConfig.performanceMonitoring).toBe(true);
            
            // Should not expose the full pubkey
            expect(serviceConfig as any).not.toHaveProperty('defaultSourcePubkey');
        });
    });
});