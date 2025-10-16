import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { GraphPersistence } from '../GraphPersistence.js';
import { GraphError, GraphErrorCodes } from '../types.js';
import { SocialGraph } from 'nostr-social-graph';
import { promises as fs } from 'node:fs';

describe('GraphPersistence', () => {
    let persistence: GraphPersistence;
    let testBinaryPath: string;
    let testGraph: SocialGraph;
    
    // Test pubkeys
    const testPubkeys = {
        root: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e',
        user1: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
        user2: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
        user3: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0',
    };
    
    beforeEach(async () => {
        testBinaryPath = `test-graph-${Date.now()}.bin`;
        persistence = new GraphPersistence(testBinaryPath);
        
        // Create a test graph with some follow relationships
        testGraph = new SocialGraph(testPubkeys.root);
        
        // Add follow events
        const followEvent1 = {
            created_at: 1000,
            content: '',
            tags: [['p', testPubkeys.user1]],
            kind: 3,
            pubkey: testPubkeys.root,
            id: 'event1',
            sig: 'signature1',
        };
        
        const followEvent2 = {
            created_at: 2000,
            content: '',
            tags: [['p', testPubkeys.user2]],
            kind: 3,
            pubkey: testPubkeys.user1,
            id: 'event2',
            sig: 'signature2',
        };
        
        testGraph.handleEvent(followEvent1, true);
        testGraph.handleEvent(followEvent2, true);
        await testGraph.recalculateFollowDistances();
    });
    
    afterEach(async () => {
        // Clean up test files
        try {
            await fs.unlink(testBinaryPath);
        } catch {
            // File might not exist, ignore
        }
    });
    
    describe('saveGraph', () => {
        it('should save a graph to binary file', async () => {
            await persistence.saveGraph(testGraph, testPubkeys.root);
            
            const exists = await persistence.exists();
            expect(exists).toBe(true);
            
            const fileSize = await persistence.getFileSize();
            expect(fileSize).toBeGreaterThan(0);
        });
        
        it('should throw error when saving null graph', async () => {
            await expect(persistence.saveGraph(null as any, testPubkeys.root))
                .rejects.toThrow(GraphError);
        });
        
        it('should validate graph before saving', async () => {
            // Create empty graph
            const emptyGraph = new SocialGraph(testPubkeys.root);
            await persistence.saveGraph(emptyGraph, testPubkeys.root);
            
            const exists = await persistence.exists();
            expect(exists).toBe(true);
            
            const fileSize = await persistence.getFileSize();
            expect(fileSize).toBeGreaterThan(0);
        });
    });
    
    describe('loadGraph', () => {
        beforeEach(async () => {
            // Save a test graph first
            await persistence.saveGraph(testGraph, testPubkeys.root);
        });
        
        it('should load a graph from binary file', async () => {
            const loadedGraph = await persistence.loadGraph(testPubkeys.root);
            
            expect(loadedGraph).toBeDefined();
            expect(loadedGraph!.getRoot()).toBe(testPubkeys.root);
            
            const stats = loadedGraph!.size();
            expect(stats.users).toBeGreaterThan(0);
            expect(stats.follows).toBeGreaterThan(0);
            
            // Test that distances are preserved
            expect(loadedGraph!.getFollowDistance(testPubkeys.root)).toBe(0);
            expect(loadedGraph!.getFollowDistance(testPubkeys.user1)).toBe(1);
            expect(loadedGraph!.getFollowDistance(testPubkeys.user2)).toBe(2);
        });
        
        it('should throw error for non-existent file', async () => {
            const nonExistentPersistence = new GraphPersistence('non-existent.bin');
            await expect(nonExistentPersistence.loadGraph(testPubkeys.root))
                .rejects.toThrow(GraphError);
        });
        
        it('should throw error with correct code for missing file', async () => {
            const nonExistentPersistence = new GraphPersistence('non-existent.bin');
            try {
                await nonExistentPersistence.loadGraph(testPubkeys.root);
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(GraphError);
                expect((error as GraphError).code).toBe(GraphErrorCodes.BINARY_NOT_FOUND);
            }
        });
    });
    
    describe('saveGraphWithBudget', () => {
        it('should save graph with budget parameters', async () => {
            await persistence.saveGraphWithBudget(testGraph, testPubkeys.root, {
                maxNodes: 2,
                maxEdges: 1,
                maxDistance: 1,
                maxEdgesPerNode: 1
            });
            
            const exists = await persistence.exists();
            expect(exists).toBe(true);
            
            const fileSize = await persistence.getFileSize();
            expect(fileSize).toBeGreaterThan(0);
        });
        
        it('should save graph without budget parameters', async () => {
            await persistence.saveGraphWithBudget(testGraph, testPubkeys.root);
            
            const exists = await persistence.exists();
            expect(exists).toBe(true);
            
            const fileSize = await persistence.getFileSize();
            expect(fileSize).toBeGreaterThan(0);
        });
    });
    
    describe('validateBinaryFile', () => {
        it('should return false for non-existent file', async () => {
            const nonExistentPersistence = new GraphPersistence('non-existent.bin');
            const isValid = await nonExistentPersistence.validateBinaryFile();
            expect(isValid).toBe(false);
        });
        
        it('should return true for valid binary file', async () => {
            await persistence.saveGraph(testGraph, testPubkeys.root);
            const isValid = await persistence.validateBinaryFile();
            expect(isValid).toBe(true);
        });
    });
    
    describe('round trip', () => {
        it('should preserve graph data through save/load cycle', async () => {
            // Save the graph
            await persistence.saveGraph(testGraph, testPubkeys.root);
            
            // Load it back
            const loadedGraph = await persistence.loadGraph(testPubkeys.root);
            expect(loadedGraph).toBeDefined();
            
            // Verify distances are preserved
            expect(loadedGraph!.getFollowDistance(testPubkeys.root)).toBe(0);
            expect(loadedGraph!.getFollowDistance(testPubkeys.user1)).toBe(1);
            expect(loadedGraph!.getFollowDistance(testPubkeys.user2)).toBe(2);
            
            // Verify following relationships are preserved
            expect(loadedGraph!.isFollowing(testPubkeys.root, testPubkeys.user1)).toBe(true);
            expect(loadedGraph!.isFollowing(testPubkeys.user1, testPubkeys.user2)).toBe(true);
        });
        
        it('should handle different root pubkeys', async () => {
            // Save with one root
            await persistence.saveGraph(testGraph, testPubkeys.root);
            
            // Load with different root
            const loadedGraph = await persistence.loadGraph(testPubkeys.user1);
            expect(loadedGraph).toBeDefined();
            expect(loadedGraph!.getRoot()).toBe(testPubkeys.user1);
        });
    });
});