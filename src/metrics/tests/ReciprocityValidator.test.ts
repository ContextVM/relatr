import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SimplePool } from 'nostr-tools/pool';
import { ReciprocityValidator } from '../validators/ReciprocityValidator';
import { SocialGraphManager } from '../../social-graph/SocialGraphManager';
import { MetricsError, MetricsErrorCodes } from '../types';

// Mock nostr-tools
const mockPool = {
    get: mock(() => Promise.resolve(null)),
} as any;

// Mock relays
const mockRelays = ['wss://relay.damus.io', 'wss://relay.nostr.band'];

// Mock SocialGraphManager
const mockGraphManager = {
    isManagerInitialized: mock(() => true),
    isInGraph: mock(() => true),
    isFollowing: mock(() => false),
} as any;

describe('ReciprocityValidator', () => {
    let validator: ReciprocityValidator;
    
    beforeEach(() => {
        validator = new ReciprocityValidator(mockPool, mockRelays);
        mockPool.get.mockClear();
        
        // Reset graph manager mocks
        if (mockGraphManager.isManagerInitialized.mockClear) {
            mockGraphManager.isManagerInitialized.mockClear();
        }
        if (mockGraphManager.isInGraph.mockClear) {
            mockGraphManager.isInGraph.mockClear();
        }
        if (mockGraphManager.isFollowing.mockClear) {
            mockGraphManager.isFollowing.mockClear();
        }
    });
    
    describe('core functionality', () => {
        it('should detect reciprocal follows correctly', async () => {
            // Setup graph manager with reciprocal follows
            mockGraphManager.isFollowing
                .mockReturnValueOnce(true) // source follows target
                .mockReturnValueOnce(true); // target follows source
            
            validator.setGraphManager(mockGraphManager);
            
            const result = await validator.checkReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(true);
        });
        
        it('should detect non-reciprocal follows', async () => {
            // Setup graph manager with one-way follow
            mockGraphManager.isFollowing
                .mockReturnValueOnce(true)  // source follows target
                .mockReturnValueOnce(false); // target does not follow source
            
            validator.setGraphManager(mockGraphManager);
            
            const result = await validator.checkReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(false);
        });
        
        it('should provide detailed reciprocity results', async () => {
            // Setup graph manager
            mockGraphManager.isFollowing
                .mockReturnValueOnce(true)  // source follows target
                .mockReturnValueOnce(false); // target does not follow source
            
            validator.setGraphManager(mockGraphManager);
            
            const result = await validator.validateReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toEqual({
                isReciprocal: false,
                sourceFollowsTarget: true,
                targetFollowsSource: false,
                sourceInGraph: true,
                targetInGraph: true,
                verifiedAt: expect.any(Number),
            });
        });
    });
    
    describe('social graph integration', () => {
        it('should use social graph when available', async () => {
            mockGraphManager.isFollowing.mockReturnValue(true);
            validator.setGraphManager(mockGraphManager);
            
            await validator.checkReciprocity('source-pubkey', 'target-pubkey');
            
            expect(mockGraphManager.isFollowing).toHaveBeenCalledWith('source-pubkey', 'target-pubkey');
            expect(mockGraphManager.isFollowing).toHaveBeenCalledWith('target-pubkey', 'source-pubkey');
            expect(mockPool.get).not.toHaveBeenCalled();
        });
        
        it('should fall back to relay queries when graph not available', async () => {
            // Mock follow list events
            const sourceFollowList = {
                kind: 3,
                pubkey: 'source-pubkey',
                tags: [['p', 'target-pubkey']],
            };
            const targetFollowList = {
                kind: 3,
                pubkey: 'target-pubkey',
                tags: [['p', 'source-pubkey']],
            };
            
            mockPool.get
                .mockResolvedValueOnce(sourceFollowList)
                .mockResolvedValueOnce(targetFollowList);
            
            const result = await validator.checkReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(true);
            expect(mockPool.get).toHaveBeenCalledTimes(2);
        });
        
        it('should handle pubkeys not in graph', async () => {
            mockGraphManager.isInGraph.mockReturnValue(false);
            validator.setGraphManager(mockGraphManager);
            
            const result = await validator.validateReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toEqual({
                isReciprocal: false,
                sourceFollowsTarget: false,
                targetFollowsSource: false,
                sourceInGraph: false,
                targetInGraph: false,
                verifiedAt: expect.any(Number),
            });
        });
    });
    
    describe('relay fallback', () => {
        it('should check follow relationships via relays', async () => {
            const followList = {
                kind: 3,
                pubkey: 'source-pubkey',
                tags: [['p', 'target-pubkey'], ['p', 'other-pubkey']],
            };
            mockPool.get.mockResolvedValue(followList);
            
            const result = await validator.isFollowing('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(true);
            expect(mockPool.get).toHaveBeenCalledWith(mockRelays, {
                kinds: [3],
                authors: ['source-pubkey'],
            });
        });
        
        it('should return false when follow list not found', async () => {
            mockPool.get.mockResolvedValue(null);
            
            const result = await validator.isFollowing('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(false);
        });
        
        it('should handle malformed follow lists', async () => {
            const malformedFollowList = {
                kind: 3,
                pubkey: 'source-pubkey',
                tags: [['invalid'], ['p', ''], ['p', 'target-pubkey']],
            };
            mockPool.get.mockResolvedValue(malformedFollowList);
            
            const result = await validator.isFollowing('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(true); // Should still find the valid p-tag
        });
    });
    
    describe('error handling', () => {
        it('should handle network errors gracefully', async () => {
            mockPool.get.mockRejectedValue(new Error('Network error'));
            
            const result = await validator.checkReciprocity('source-pubkey', 'target-pubkey');
            
            expect(result).toBe(false);
        });
        
        it('should throw MetricsError for timeout scenarios', async () => {
            mockPool.get.mockRejectedValue(new Error('Operation timed out after 5000ms'));
            
            try {
                await validator.validateReciprocity('source-pubkey', 'target-pubkey');
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(MetricsError);
                if (error instanceof MetricsError) {
                    expect(error.code).toBe(MetricsErrorCodes.TIMEOUT_ERROR);
                    expect(error.metric).toBe('reciprocity');
                }
            }
        });
    });
    
    describe('batch operations', () => {
        it('should validate reciprocity for multiple pubkey pairs', async () => {
            // Setup graph manager
            mockGraphManager.isFollowing.mockReturnValue(true);
            validator.setGraphManager(mockGraphManager);
            
            const pairs = [
                { sourcePubkey: 'pubkey1', targetPubkey: 'pubkey2' },
                { sourcePubkey: 'pubkey3', targetPubkey: 'pubkey4' },
                { sourcePubkey: 'pubkey5', targetPubkey: 'pubkey6' },
            ];
            
            const results = await validator.validateBatch(pairs);
            
            expect(results).toHaveLength(3);
            results.forEach(result => {
                expect(result.isReciprocal).toBe(true);
                expect(result.sourceFollowsTarget).toBe(true);
                expect(result.targetFollowsSource).toBe(true);
            });
        });
        
        it('should handle mixed success/failure in batch operations', async () => {
            mockGraphManager.isFollowing
                .mockReturnValueOnce(true)  // First pair: reciprocal
                .mockReturnValueOnce(true)
                .mockRejectedValueOnce(new Error('Network error')) // Second pair: error
                .mockReturnValueOnce(false) // Third pair: non-reciprocal
                .mockReturnValueOnce(true);
            
            validator.setGraphManager(mockGraphManager);
            
            const pairs = [
                { sourcePubkey: 'pubkey1', targetPubkey: 'pubkey2' },
                { sourcePubkey: 'pubkey3', targetPubkey: 'pubkey4' },
                { sourcePubkey: 'pubkey5', targetPubkey: 'pubkey6' },
            ];
            
            const results = await validator.validateBatch(pairs);
            
            expect(results).toHaveLength(3);
            expect(results[0]?.isReciprocal).toBe(true);
            expect(results[1]?.isReciprocal).toBe(false);
            expect(results[1]?.error).toBeDefined();
            expect(results[2]?.isReciprocal).toBe(false);
        });
    });
    
    describe('graph manager management', () => {
        it('should allow setting and removing graph manager', () => {
            expect(validator.hasGraphManager()).toBe(false);
            
            validator.setGraphManager(mockGraphManager);
            expect(validator.hasGraphManager()).toBe(true);
            
            validator.removeGraphManager();
            expect(validator.hasGraphManager()).toBe(false);
        });
        
        it('should check if graph manager is initialized', () => {
            mockGraphManager.isManagerInitialized.mockReturnValue(false);
            validator.setGraphManager(mockGraphManager);
            
            expect(validator.hasGraphManager()).toBe(false);
        });
    });
    
    describe('configuration', () => {
        it('should allow configuration updates', () => {
            const originalConfig = validator.getConfig();
            
            validator.updateConfig({
                timeout: 10000,
                enableLogging: false,
            });
            
            const updatedConfig = validator.getConfig();
            expect(updatedConfig.timeout).toBe(10000);
            expect(updatedConfig.enableLogging).toBe(false);
            expect(updatedConfig.retries).toBe(originalConfig.retries); // Should preserve existing values
        });
        
        it('should allow relay updates', () => {
            const newRelays = ['wss://new-relay.com'];
            validator.updateRelays(newRelays);
            
            expect(validator.getRelays()).toEqual(newRelays);
        });
    });
});