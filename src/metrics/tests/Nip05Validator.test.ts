import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { Nip05Validator } from '../validators/Nip05Validator';
import { MetricsError, MetricsErrorCodes, type NostrProfile } from '../types';

// Mock the nostr-tools/nip05 module
const mockQueryProfile = spyOn(await import('nostr-tools/nip05'), 'queryProfile');

describe('Nip05Validator', () => {
    let validator: Nip05Validator;
    
    beforeEach(() => {
        validator = new Nip05Validator({
            timeout: 1000,
            retries: 1,
            retryDelay: 100,
            enableLogging: false,
            wellKnownTimeout: 500,
            verifySignature: true,
        });
        
        // Reset all mocks
        mockQueryProfile.mockClear();
    });
    
    describe('validate', () => {
        it('should return false when profile has no nip05 field', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
            };
            
            const result = await validator.validate(profile, 'test-pubkey');
            expect(result).toBe(false);
        });
        
        it('should return true for valid NIP-05 with matching pubkey', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                nip05: 'user@example.com',
            };
            
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce({
                pubkey: pubkey,
            } as any);
            
            const result = await validator.validate(profile, pubkey);
            expect(result).toBe(true);
            expect(mockQueryProfile).toHaveBeenCalledWith('user@example.com');
        });
        
        it('should return false for valid NIP-05 with non-matching pubkey', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                nip05: 'user@example.com',
            };
            
            const expectedPubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            const actualPubkey = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
            
            mockQueryProfile.mockResolvedValueOnce({
                pubkey: actualPubkey,
            } as any);
            
            const result = await validator.validate(profile, expectedPubkey);
            expect(result).toBe(false);
        });
        
        it('should return false when NIP-05 query returns no profile', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                nip05: 'user@example.com',
            };
            
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce(null);
            
            const result = await validator.validate(profile, pubkey);
            expect(result).toBe(false);
        });
        
        it('should return false when NIP-05 query returns profile without pubkey', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                nip05: 'user@example.com',
            };
            
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce({
                name: 'User',
            } as any);
            
            const result = await validator.validate(profile, pubkey);
            expect(result).toBe(false);
        });
        
        it('should return false when NIP-05 query throws error', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                nip05: 'user@example.com',
            };
            
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockRejectedValueOnce(new Error('Network error'));
            
            const result = await validator.validate(profile, pubkey);
            expect(result).toBe(false);
        });
    });
    
    describe('validateWithPubkey', () => {
        it('should validate successfully with matching pubkey', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce({
                pubkey: pubkey,
            } as any);
            
            const result = await validator.validateWithPubkey(nip05, pubkey);
            
            expect(result.valid).toBe(true);
            expect(result.nip05).toBe(nip05);
            expect(result.pubkey).toBe(pubkey);
            expect(result.domain).toBe('example.com');
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
        
        it('should fail with non-matching pubkey', async () => {
            const nip05 = 'user@example.com';
            const expectedPubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            const actualPubkey = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
            
            mockQueryProfile.mockResolvedValueOnce({
                pubkey: actualPubkey,
            } as any);
            
            const result = await validator.validateWithPubkey(nip05, expectedPubkey);
            
            expect(result.valid).toBe(false);
            expect(result.nip05).toBe(nip05);
            expect(result.pubkey).toBe(actualPubkey);
            expect(result.domain).toBe('example.com');
        });
        
        it('should throw MetricsError for invalid NIP-05 format', async () => {
            const nip05 = 'invalid-nip05';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_VERIFICATION_FAILED);
                expect(error.metric).toBe('nip05');
            }
        });
        
        it('should throw MetricsError when no profile found', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce(null);
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_VERIFICATION_FAILED);
            }
        });
        
        it('should throw MetricsError when profile has no pubkey', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockResolvedValueOnce({
                name: 'User',
            } as any);
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_VERIFICATION_FAILED);
            }
        });
        
        it('should throw MetricsError for timeout', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockImplementationOnce(() => 
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('timeout')), 100)
                )
            );
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_TIMEOUT);
            }
        });
        
        it('should throw MetricsError for domain errors', async () => {
            const nip05 = 'user@nonexistent-domain.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockRejectedValueOnce(new Error('ENOTFOUND nonexistent-domain.com'));
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_DOMAIN_ERROR);
            }
        });
    });
    
    describe('NIP-05 format validation', () => {
        it('should accept valid email-like formats', async () => {
            const validFormats = [
                'user@example.com',
                'test.user@sub.domain.co.uk',
                '123@domain.com',
                'user_name@example-domain.com',
                'a@b.co',
            ];
            
            for (const nip05 of validFormats) {
                const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
                
                mockQueryProfile.mockResolvedValueOnce({
                    pubkey: pubkey,
                } as any);
                
                const result = await validator.validateWithPubkey(nip05, pubkey);
                expect(result.valid).toBe(true);
                expect(result.nip05).toBe(nip05);
            }
        });
        
        it('should reject invalid formats', async () => {
            const invalidFormats = [
                'invalid-nip05',
                '@example.com',
                'user@',
                'user',
                'user@.com',
                'user@com.',
                'user@-domain.com',
                'user@domain-.com',
                'user..name@example.com',
                'user@domain..com',
                '',
                'user@domain.toolong' + 'a'.repeat(250),
                'a'.repeat(65) + '@example.com',
            ];
            
            for (const nip05 of invalidFormats) {
                const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
                
                try {
                    await validator.validateWithPubkey(nip05, pubkey);
                    expect().fail(`Should have rejected invalid format: ${nip05}`);
                } catch (error: any) {
                    expect(error).toBeInstanceOf(MetricsError);
                    expect(error.code).toBe(MetricsErrorCodes.NIP05_VERIFICATION_FAILED);
                }
            }
        });
    });
    
    describe('validateBatch', () => {
        it('should validate multiple NIP-05 addresses in parallel', async () => {
            const entries = [
                { nip05: 'user1@example.com', pubkey: 'pubkey1' },
                { nip05: 'user2@example.com', pubkey: 'pubkey2' },
                { nip05: 'user3@example.com', pubkey: 'pubkey3' },
            ];
            
            // Mock successful validations
            mockQueryProfile.mockImplementation(async (nip05: string) => {
                const pubkey = entries.find(e => e.nip05 === nip05)?.pubkey;
                return Promise.resolve({ pubkey } as any);
            });
            
            const results = await validator.validateBatch(entries);
            
            expect(results).toHaveLength(3);
            expect(results[0]!.valid).toBe(true);
            expect(results[1]!.valid).toBe(true);
            expect(results[2]!.valid).toBe(true);
        });
        
        it('should handle mixed successful and failed validations', async () => {
            const entries = [
                { nip05: 'valid@example.com', pubkey: 'pubkey1' },
                { nip05: 'invalid-format', pubkey: 'pubkey2' },
                { nip05: 'nonexistent@domain.com', pubkey: 'pubkey3' },
            ];
            
            // Mock mixed responses
            mockQueryProfile.mockImplementation(async (nip05: string) => {
                if (nip05 === 'valid@example.com') {
                    return Promise.resolve({ pubkey: 'pubkey1' } as any);
                } else if (nip05 === 'nonexistent@domain.com') {
                    return Promise.resolve(null);
                }
                return Promise.resolve(null);
            });
            
            const results = await validator.validateBatch(entries);
            
            expect(results).toHaveLength(3);
            expect(results[0]!.valid).toBe(true);
            expect(results[1]!.valid).toBe(false);
            expect(results[2]!.valid).toBe(false);
        });
    });
    
    describe('configuration', () => {
        it('should use default configuration when none provided', () => {
            const defaultValidator = new Nip05Validator();
            const config = defaultValidator.getConfig();
            
            expect(config.timeout).toBe(5000);
            expect(config.retries).toBe(2);
            expect(config.retryDelay).toBe(1000);
            expect(config.enableLogging).toBe(true);
            expect(config.wellKnownTimeout).toBe(3000);
            expect(config.verifySignature).toBe(true);
        });
        
        it('should merge custom configuration with defaults', () => {
            const customValidator = new Nip05Validator({
                timeout: 10000,
                enableLogging: false,
            });
            
            const config = customValidator.getConfig();
            
            expect(config.timeout).toBe(10000);
            expect(config.retries).toBe(2); // Default value
            expect(config.enableLogging).toBe(false);
        });
        
        it('should update configuration', () => {
            validator.updateConfig({
                timeout: 2000,
                retries: 5,
            });
            
            const config = validator.getConfig();
            
            expect(config.timeout).toBe(2000);
            expect(config.retries).toBe(5);
            expect(config.enableLogging).toBe(false); // Previous value
        });
    });
    
    describe('error handling', () => {
        it('should wrap non-MetricsError exceptions', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockRejectedValueOnce(new Error('Unexpected error'));
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_VERIFICATION_FAILED);
                expect(error.message).toContain('Unexpected error');
            }
        });
        
        it('should handle connection refused errors', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockRejectedValueOnce(new Error('ECONNREFUSED'));
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_DOMAIN_ERROR);
            }
        });
        
        it('should handle fetch errors', async () => {
            const nip05 = 'user@example.com';
            const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
            
            mockQueryProfile.mockRejectedValueOnce(new Error('fetch failed'));
            
            try {
                await validator.validateWithPubkey(nip05, pubkey);
                expect().fail('Should have thrown MetricsError');
            } catch (error: any) {
                expect(error).toBeInstanceOf(MetricsError);
                expect(error.code).toBe(MetricsErrorCodes.NIP05_DOMAIN_ERROR);
            }
        });
    });
});