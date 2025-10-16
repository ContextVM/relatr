import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SocialGraphManager } from '../SocialGraphManager.js';
import { GraphPersistence } from '../GraphPersistence.js';
import { config } from '../../config/environment.js';

describe('Social Graph Integration Tests', () => {
    let manager: SocialGraphManager;
    let persistence: GraphPersistence;
    
    // Test pubkeys (using real Nostr pubkeys for more realistic testing)
    const testPubkeys = {
        // These are real Nostr pubkeys from the network
        adam: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e',
        fiatjaf: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
        snowden: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
        sirius: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0',
        unknown: '0000000000000000000000000000000000000000000000000000000000000000',
    };
    
    beforeAll(async () => {
        // Initialize once for all tests to improve performance
        persistence = new GraphPersistence(config.GRAPH_BINARY_PATH);
        
        manager = new SocialGraphManager({
            rootPubkey: config.DEFAULT_SOURCE_PUBKEY,
            graphBinaryPath: config.GRAPH_BINARY_PATH,
            autoSave: false // Disable auto-save for testing
        });
        
        try {
            await manager.initialize();
        } catch (error) {
            console.error('Failed to initialize manager in beforeAll:', error);
            throw error;
        }
    });
    
    afterAll(async () => {
        await manager.cleanup();
    });
    
    
    
    describe('binary file validation', () => {
        it('should validate that social graph binary file exists', async () => {
            const exists = await persistence.exists();
            expect(exists).toBe(true);
        });
        
        it('should validate binary file format', async () => {
            const isValid = await persistence.validateBinaryFile();
            expect(isValid).toBe(true);
        });
        
        it('should get file size', async () => {
            const fileSize = await persistence.getFileSize();
            expect(fileSize).toBeGreaterThan(0);
            console.log(`Social graph binary file size: ${fileSize} bytes`);
        });
    });
    
    describe('graph loading and initialization', () => {
        it('should initialize successfully with existing binary file', () => {
            const stats = manager.getStats();
            expect(stats.users).toBeGreaterThan(0);
            expect(stats.edges).toBeGreaterThan(0);
            
            console.log(`Loaded graph with ${stats.users} users and ${stats.edges} edges`);
        });
        
        it('should load graph with correct root pubkey', () => {
            const currentRoot = manager.getCurrentRoot();
            expect(currentRoot).toBe(config.DEFAULT_SOURCE_PUBKEY);
        });
        
        it('should preserve graph statistics after loading', () => {
            const stats = manager.getGraphStatistics();
            expect(stats.rootPubkey).toBe(config.DEFAULT_SOURCE_PUBKEY);
            expect(stats.users).toBeGreaterThan(0);
            expect(stats.edges).toBeGreaterThan(0);
        });
    });
    
    describe('distance calculations', () => {
        it('should calculate distance from root to root as 0', () => {
            const distance = manager.getFollowDistance(config.DEFAULT_SOURCE_PUBKEY);
            expect(distance).toBe(0);
        });
        
        it('should calculate distances to known pubkeys', () => {
            // Test with some known pubkeys that might be in the graph
            const distances = testPubkeys;
            
            for (const [name, pubkey] of Object.entries(distances)) {
                const distance = manager.getFollowDistance(pubkey);
                expect(typeof distance).toBe('number');
                expect(distance).toBeGreaterThanOrEqual(0);
                
                if (distance < 1000) {
                    console.log(`Distance to ${name}: ${distance} hops`);
                } else {
                    console.log(`${name} is not reachable from root`);
                }
            }
        });
        
        it('should return 1000 for unknown pubkeys', () => {
            const distance = manager.getFollowDistance(testPubkeys.unknown);
            expect(distance).toBe(1000);
        });
        
        it('should calculate distances between any two pubkeys', async () => {
            // Test distance between two known pubkeys
            const distance = await manager.getDistanceBetween(
                testPubkeys.adam, 
                testPubkeys.fiatjaf
            );
            
            expect(typeof distance).toBe('number');
            expect(distance).toBeGreaterThanOrEqual(0);
            
            console.log(`Distance between adam and fiatjaf: ${distance} hops`);
        });
        
        it('should handle distance queries efficiently', async () => {
            const startTime = performance.now();
            
            // Perform multiple distance queries
            for (let i = 0; i < 100; i++) {
                manager.getFollowDistance(testPubkeys.adam);
            }
            
            const endTime = performance.now();
            const avgTime = (endTime - startTime) / 100;
            
            console.log(`Average distance query time: ${avgTime.toFixed(2)}ms`);
            
            // Distance queries should be very fast (under 1ms on average)
            expect(avgTime).toBeLessThan(1);
        });
    });
    
    describe('root switching', () => {
        it('should switch root successfully', async () => {
            const originalRoot = manager.getCurrentRoot();
            
            await manager.switchRoot(testPubkeys.adam);
            const newRoot = manager.getCurrentRoot();
            
            expect(newRoot).toBe(testPubkeys.adam);
            expect(newRoot).not.toBe(originalRoot);
            
            // Distance from new root to itself should be 0
            const distance = manager.getFollowDistance(testPubkeys.adam);
            expect(distance).toBe(0);
        });
        
        it('should recalculate distances after root switch', async () => {
            // Get initial distances
            const initialDistanceToAdam = manager.getFollowDistance(testPubkeys.adam);
            const initialDistanceToFiatjaf = manager.getFollowDistance(testPubkeys.fiatjaf);
            
            // Switch root to adam
            await manager.switchRoot(testPubkeys.adam);
            
            // After switching, distance to adam should be 0
            const newDistanceToAdam = manager.getFollowDistance(testPubkeys.adam);
            expect(newDistanceToAdam).toBe(0);
            
            // Distance to other users should be different
            const newDistanceToFiatjaf = manager.getFollowDistance(testPubkeys.fiatjaf);
            
            console.log(`Distance to adam before switch: ${initialDistanceToAdam}, after: ${newDistanceToAdam}`);
            console.log(`Distance to fiatjaf before switch: ${initialDistanceToFiatjaf}, after: ${newDistanceToFiatjaf}`);
        });
        
        it('should handle multiple root switches', async () => {
            const roots = [testPubkeys.adam, testPubkeys.fiatjaf, testPubkeys.snowden];
            
            for (const root of roots) {
                await manager.switchRoot(root);
                
                const currentRoot = manager.getCurrentRoot();
                expect(currentRoot).toBe(root);
                
                const distanceToSelf = manager.getFollowDistance(root);
                expect(distanceToSelf).toBe(0);
            }
        });
    });
    
    describe('following relationships', () => {
        it('should check following relationships', () => {
            const isFollowing = manager.isFollowing(testPubkeys.adam, testPubkeys.fiatjaf);
            expect(typeof isFollowing).toBe('boolean');
            
            console.log(`Adam follows Fiatjaf: ${isFollowing}`);
        });
        
        it('should check reciprocal relationships', () => {
            const isReciprocal = manager.isReciprocal(testPubkeys.adam, testPubkeys.fiatjaf);
            expect(typeof isReciprocal).toBe('boolean');
            
            console.log(`Adam and Fiatjaf have mutual follow: ${isReciprocal}`);
        });
        
        it('should check if pubkeys are in graph', () => {
            const adamInGraph = manager.isInGraph(testPubkeys.adam);
            const unknownInGraph = manager.isInGraph(testPubkeys.unknown);
            
            expect(typeof adamInGraph).toBe('boolean');
            expect(typeof unknownInGraph).toBe('boolean');
            
            console.log(`Adam is in graph: ${adamInGraph}`);
            console.log(`Unknown pubkey is in graph: ${unknownInGraph}`);
        });
    });
    
    describe('mute functionality', () => {
        it('should get muted users', () => {
            const mutedUsers = manager.getMutedByUser(testPubkeys.adam);
            expect(Array.isArray(mutedUsers)).toBe(true);
            
            console.log(`Adam has muted ${mutedUsers.length} users`);
        });
        
        it('should get users who muted someone', () => {
            const muters = manager.getUserMutedBy(testPubkeys.fiatjaf);
            expect(Array.isArray(muters)).toBe(true);
            
            console.log(`${muters.length} users have muted Fiatjaf`);
        });
    });
    
    describe('error handling', () => {
        it('should handle invalid pubkeys gracefully', () => {
            // Test with invalid pubkey format
            const invalidPubkey = 'invalid-pubkey';
            
            expect(() => manager.getFollowDistance(invalidPubkey)).not.toThrow();
            expect(() => manager.isFollowing(invalidPubkey, testPubkeys.adam)).not.toThrow();
            expect(() => manager.isInGraph(invalidPubkey)).not.toThrow();
        });
        
        it('should handle operations after cleanup', async () => {
            // Create a separate manager for cleanup test
            const cleanupManager = new SocialGraphManager({
                rootPubkey: config.DEFAULT_SOURCE_PUBKEY,
                graphBinaryPath: config.GRAPH_BINARY_PATH,
                autoSave: false
            });
            
            await cleanupManager.initialize();
            await cleanupManager.cleanup();
            
            expect(() => cleanupManager.getFollowDistance(testPubkeys.adam)).toThrow();
        });
    });
});