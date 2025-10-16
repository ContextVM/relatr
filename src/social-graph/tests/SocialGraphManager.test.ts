import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SocialGraphManager } from '../SocialGraphManager.js';
import { GraphError, GraphErrorCodes } from '../types.js';
import { promises as fs } from 'node:fs';

describe('SocialGraphManager', () => {
    let manager: SocialGraphManager;
    let testBinaryPath: string;
    
    // Test pubkeys
    const testPubkeys = {
        root: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e',
        user1: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
        user2: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
        user3: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0',
        unknown: '0000000000000000000000000000000000000000000000000000000000000000',
    };
    
    beforeAll(async () => {
        // Initialize shared manager for all tests that need the real graph
        try {
            await fs.access('data/socialGraph.bin');
            
            manager = new SocialGraphManager({
                rootPubkey: testPubkeys.root,
                graphBinaryPath: 'data/socialGraph.bin',
                autoSave: false
            });
            
            await manager.initialize();
        } catch (error) {
            console.warn('Failed to initialize shared manager with real graph:', error);
            console.warn('Some tests may be skipped');
        }
    });
    
    afterAll(async () => {
        if (manager && manager.isManagerInitialized()) {
            await manager.cleanup();
        }
    });
    
    describe('initialization', () => {
        it('should throw error when operations called before initialization', () => {
            const freshManager = new SocialGraphManager({
                rootPubkey: testPubkeys.root,
                graphBinaryPath: 'non-existent.bin',
                autoSave: false
            });
            
            expect(() => freshManager.getFollowDistance(testPubkeys.user1))
                .toThrow(GraphError);
        });
        
        it('should throw error with correct code when not initialized', () => {
            const freshManager = new SocialGraphManager({
                rootPubkey: testPubkeys.root,
                graphBinaryPath: 'non-existent.bin',
                autoSave: false
            });
            
            try {
                freshManager.getFollowDistance(testPubkeys.user1);
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(GraphError);
                expect((error as GraphError).code).toBe(GraphErrorCodes.NOT_INITIALIZED);
            }
        });
        
        it('should throw error for non-existent binary file', async () => {
            const badManager = new SocialGraphManager({
                rootPubkey: testPubkeys.root,
                graphBinaryPath: 'non-existent.bin'
            });
            
            await expect(badManager.initialize()).rejects.toThrow(GraphError);
            await badManager.cleanup();
        });
    });
    
    describe('distance queries', () => {
        it('should get follow distance from root', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping distance test - manager not initialized');
                return;
            }
            
            const distance = manager.getFollowDistance(testPubkeys.user1);
            expect(typeof distance).toBe('number');
            expect(distance).toBeGreaterThanOrEqual(0);
        });
        
        it('should get distance to root', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping distance test - manager not initialized');
                return;
            }
            
            const distance = manager.getDistanceToRoot(testPubkeys.user1);
            expect(typeof distance).toBe('number');
            expect(distance).toBeGreaterThanOrEqual(0);
        });
        
        it('should get distance between two pubkeys', async () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping distance test - manager not initialized');
                return;
            }
            
            const distance = await manager.getDistanceBetween(testPubkeys.user1, testPubkeys.user2);
            expect(typeof distance).toBe('number');
            expect(distance).toBeGreaterThanOrEqual(0);
        });
                
        it('should get distance result with metadata', async () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping distance test - manager not initialized');
                return;
            }
            
            const result = await manager.getDistanceResult(testPubkeys.root, testPubkeys.user1);
            expect(result).toHaveProperty('sourcePubkey');
            expect(result).toHaveProperty('targetPubkey');
            expect(result).toHaveProperty('distance');
            expect(result).toHaveProperty('isReachable');
            expect(result.sourcePubkey).toBe(testPubkeys.root);
            expect(result.targetPubkey).toBe(testPubkeys.user1);
        });
    });
    
    describe('root switching', () => {
        it('should switch root successfully', async () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping root switching test - manager not initialized');
                return;
            }
            
            const originalRoot = manager.getCurrentRoot();
            await manager.switchRoot(testPubkeys.user1);
            const newRoot = manager.getCurrentRoot();
            
            expect(newRoot).toBe(testPubkeys.user1);
            expect(newRoot).not.toBe(originalRoot);
            
            // Switch back to original root for other tests
            await manager.switchRoot(originalRoot);
        });
        
        it('should handle switching to same root', async () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping root switching test - manager not initialized');
                return;
            }
            
            const originalRoot = manager.getCurrentRoot();
            await manager.switchRoot(originalRoot);
            const newRoot = manager.getCurrentRoot();
            
            expect(newRoot).toBe(originalRoot);
        });
        
        it('should recalculate distances after root switch', async () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping root switching test - manager not initialized');
                return;
            }
            
            // Distance from original root to itself should be 0
            const originalDistance = manager.getFollowDistance(manager.getCurrentRoot());
            expect(originalDistance).toBe(0);
            
            // Switch to a different root
            await manager.switchRoot(testPubkeys.user1);
            
            // Distance from new root to itself should be 0
            const newDistance = manager.getFollowDistance(testPubkeys.user1);
            expect(newDistance).toBe(0);
            
            // Switch back for other tests
            await manager.switchRoot(testPubkeys.root);
        });
    });
    
    describe('following relationships', () => {
        it('should check if one pubkey follows another', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping following test - manager not initialized');
                return;
            }
            
            const isFollowing = manager.isFollowing(testPubkeys.user1, testPubkeys.user2);
            expect(typeof isFollowing).toBe('boolean');
        });
        
        it('should check for reciprocal follows', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping following test - manager not initialized');
                return;
            }
            
            const isReciprocal = manager.isReciprocal(testPubkeys.user1, testPubkeys.user2);
            expect(typeof isReciprocal).toBe('boolean');
        });
        
        it('should check if pubkey is in graph', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping following test - manager not initialized');
                return;
            }
            
            const isInGraph = manager.isInGraph(testPubkeys.user1);
            expect(typeof isInGraph).toBe('boolean');
        });
    });
    
    describe('graph statistics', () => {
        it('should get graph statistics', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping stats test - manager not initialized');
                return;
            }
            
            const stats = manager.getGraphStatistics();
            expect(stats).toHaveProperty('users');
            expect(stats).toHaveProperty('edges');
            expect(stats).toHaveProperty('rootPubkey');
            expect(typeof stats.users).toBe('number');
            expect(typeof stats.edges).toBe('number');
            expect(typeof stats.rootPubkey).toBe('string');
        });
        
        it('should get stats (backward compatibility)', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping stats test - manager not initialized');
                return;
            }
            
            const stats = manager.getStats();
            expect(stats).toHaveProperty('users');
            expect(stats).toHaveProperty('edges');
            expect(typeof stats.users).toBe('number');
            expect(typeof stats.edges).toBe('number');
        });
    });
    
    describe('mute functionality', () => {
        it('should get muted users by a user', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping mute test - manager not initialized');
                return;
            }
            
            const mutedUsers = manager.getMutedByUser(testPubkeys.root);
            expect(Array.isArray(mutedUsers)).toBe(true);
        });
        
        it('should get users who muted a pubkey', () => {
            if (!manager || !manager.isManagerInitialized()) {
                console.warn('Skipping mute test - manager not initialized');
                return;
            }
            
            const muters = manager.getUserMutedBy(testPubkeys.user1);
            expect(Array.isArray(muters)).toBe(true);
        });
    });
    
    describe('cleanup', () => {
        it('should cleanup successfully', async () => {
            // Create a separate manager for cleanup test
            const cleanupManager = new SocialGraphManager({
                rootPubkey: testPubkeys.root,
                graphBinaryPath: 'data/socialGraph.bin',
                autoSave: false
            });
            
            await cleanupManager.initialize();
            await cleanupManager.cleanup();
            
            // Should throw error after cleanup
            expect(() => cleanupManager.getFollowDistance(testPubkeys.user1))
                .toThrow(GraphError);
        });
    });
});