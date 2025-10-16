import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SimplePool } from 'nostr-tools/pool';
import { EventValidator } from '../validators/EventValidator';
import { MetricsError, MetricsErrorCodes } from '../types';

// Mock nostr-tools
const mockPool = {
    get: mock(() => Promise.resolve(null)),
    querySync: mock(() => []),
} as any;

// Mock relays
const mockRelays = ['wss://relay.damus.io', 'wss://relay.nostr.band'];

describe('EventValidator', () => {
    let validator: EventValidator;
    
    beforeEach(() => {
        validator = new EventValidator(mockPool, mockRelays);
        mockPool.get.mockClear();
        mockPool.querySync.mockClear();
    });
    
    describe('core functionality', () => {
        it('should detect kind 10002 events correctly', async () => {
            const mockEvent = {
                id: 'event-id',
                kind: 10002,
                pubkey: 'test-pubkey',
                content: '["wss://relay.damus.io"]',
                created_at: 1234567890,
                tags: [],
                sig: 'signature',
            };
            mockPool.get.mockResolvedValue(mockEvent);
            
            const result = await validator.hasEventKind('test-pubkey', 10002);
            
            expect(result).toBe(true);
            expect(mockPool.get).toHaveBeenCalledWith(mockRelays, {
                kinds: [10002],
                authors: ['test-pubkey'],
                limit: 1,
            });
        });
        
        it('should return false when kind 10002 event is not found', async () => {
            mockPool.get.mockResolvedValue(null);
            
            const result = await validator.hasEventKind('test-pubkey', 10002);
            
            expect(result).toBe(false);
        });
        
        it('should provide detailed validation results', async () => {
            const mockEvent = {
                id: 'event-id',
                kind: 10002,
                pubkey: 'test-pubkey',
                content: '["wss://relay.damus.io", "wss://relay.nostr.band"]',
                created_at: 1234567890,
                tags: [],
                sig: 'signature',
            };
            mockPool.get.mockResolvedValue(mockEvent);
            
            const result = await validator.validateEventKind('test-pubkey', 10002);
            
            expect(result).toEqual({
                hasEvent: true,
                eventKind: 10002,
                eventId: 'event-id',
                eventContent: '["wss://relay.damus.io", "wss://relay.nostr.band"]',
                eventCreatedAt: 1234567890,
                verifiedAt: expect.any(Number),
            });
        });
    });
    
    describe('error handling', () => {
        it('should handle network errors gracefully', async () => {
            mockPool.get.mockRejectedValue(new Error('Network error'));
            
            const result = await validator.hasEventKind('test-pubkey', 10002);
            
            expect(result).toBe(false);
        });
        
        it('should throw MetricsError for timeout scenarios', async () => {
            mockPool.get.mockRejectedValue(new Error('Operation timed out after 5000ms'));
            
            try {
                await validator.validateEventKind('test-pubkey', 10002);
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(MetricsError);
                if (error instanceof MetricsError) {
                    expect(error.code).toBe(MetricsErrorCodes.TIMEOUT_ERROR);
                    expect(error.metric).toBe('event');
                    expect(error.pubkey).toBe('test-pubkey');
                }
            }
        });
    });
    
    describe('batch operations', () => {
        it('should validate event kinds for multiple pubkeys', async () => {
            const mockEvent = { 
                id: 'event-id',
                kind: 10002,
                pubkey: 'test-pubkey',
                content: 'relay list',
                created_at: 1234567890,
                tags: [],
                sig: 'signature',
            };
            mockPool.get.mockResolvedValue(mockEvent);
            
            const pubkeys = ['pubkey1', 'pubkey2', 'pubkey3'];
            const results = await validator.validateBatch(pubkeys, 10002);
            
            expect(results).toHaveLength(3);
            results.forEach(result => {
                expect(result.hasEvent).toBe(true);
                expect(result.eventKind).toBe(10002);
            });
        });
        
        it('should handle mixed success/failure in batch operations', async () => {
            mockPool.get
                .mockResolvedValueOnce({ 
                    id: 'event-1',
                    kind: 10002,
                    pubkey: 'pubkey1',
                    content: 'relay list',
                    created_at: 1234567890,
                    tags: [],
                    sig: 'signature',
                })
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce(null);
            
            const pubkeys = ['pubkey1', 'pubkey2', 'pubkey3'];
            const results = await validator.validateBatch(pubkeys, 10002);
            
            expect(results).toHaveLength(3);
            expect(results[0]?.hasEvent).toBe(true);
            expect(results[1]?.hasEvent).toBe(false);
            expect(results[1]?.error).toBeDefined();
            expect(results[2]?.hasEvent).toBe(false);
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