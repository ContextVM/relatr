
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { LightningValidator } from '../validators/LightningValidator';
import { MetricsError, MetricsErrorCodes, type NostrProfile } from '../types';

// Mock global fetch for Lightning address connectivity tests
const mockFetch = spyOn(global, 'fetch').mockImplementation(
    (() => Promise.resolve({ ok: true } as Response)) as unknown as typeof fetch
);

describe('LightningValidator', () => {
    let validator: LightningValidator;
    
    beforeEach(() => {
        validator = new LightningValidator({
            timeout: 1000,
            retries: 1,
            retryDelay: 100,
            enableLogging: false,
            validateLnurl: false, // Disable for basic tests
            checkConnectivity: false, // Disable for basic tests
        });
        
        // Reset all mocks
        mockFetch.mockClear();
    });
    
    describe('validate', () => {
        it('should return false when profile has no Lightning addresses', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
            };
            
            const result = await validator.validate(profile);
            expect(result).toBe(false);
        });
        
        it('should return true for valid lud16 address', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                lud16: 'user@example.com',
            };
            
            const result = await validator.validate(profile);
            expect(result).toBe(true);
        });
        
        it('should return true for valid lud06 address', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const result = await validator.validate(profile);
            expect(result).toBe(true);
        });
        
        it('should return false for invalid lud16 format', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                lud16: 'invalid-lightning-address',
            };
            
            const result = await validator.validate(profile);
            expect(result).toBe(false);
        });
        
        it('should return false for invalid lud06 format', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                lud06: 'invalid-lnurl',
            };
            
            const result = await validator.validate(profile);
            expect(result).toBe(false);
        });
        
        it('should prefer lud16 over lud06 when both present', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
                lud16: 'user@example.com',
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const result = await validator.validateWithDetails(profile);
            expect(result.hasAddress).toBe(true);
            expect(result.address).toBe('user@example.com');
            expect(result.type).toBe('lud16');
        });
    });
    
    describe('validateWithDetails', () => {
        it('should return detailed result for valid lud16', async () => {
            const profile: NostrProfile = {
                lud16: 'user@example.com',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.hasAddress).toBe(true);
            expect(result.address).toBe('user@example.com');
            expect(result.type).toBe('lud16');
            expect(result.validFormat).toBe(true);
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
        
        it('should return detailed result for valid lud06', async () => {
            const profile: NostrProfile = {
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.hasAddress).toBe(true);
            expect(result.address).toBe('lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr');
            expect(result.type).toBe('lud06');
            expect(result.validFormat).toBe(true);
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
        
        it('should return detailed result for invalid lud16 format', async () => {
            const profile: NostrProfile = {
                lud16: 'invalid-address',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.hasAddress).toBe(true);
            expect(result.address).toBe('invalid-address');
            expect(result.type).toBe('lud16');
            expect(result.validFormat).toBe(false);
            expect(result.error).toBe('Invalid Lightning Address format');
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
        
        it('should return detailed result for invalid lud06 format', async () => {
            const profile: NostrProfile = {
                lud06: 'invalid-lnurl',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.hasAddress).toBe(true);
            expect(result.address).toBe('invalid-lnurl');
            expect(result.type).toBe('lud06');
            expect(result.validFormat).toBe(false);
            expect(result.error).toBe('Invalid LNURL format');
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
        
        it('should return result with no address when none present', async () => {
            const profile: NostrProfile = {
                name: 'Test User',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.hasAddress).toBe(false);
            expect(result.address).toBeUndefined();
            expect(result.type).toBeUndefined();
            expect(result.validFormat).toBe(false);
            expect(result.verifiedAt).toBeGreaterThan(0);
        });
    });
    
    describe('Lightning Address format validation', () => {
        it('should accept valid Lightning Address formats', async () => {
            const validAddresses = [
                'user@example.com',
                'test.user@sub.domain.co.uk',
                '123@domain.com',
                'user_name@example-domain.com',
                'a@b.co',
                'user@lightning-address.com',
                'satoshi@walletofsatoshi.com',
            ];
            
            for (const address of validAddresses) {
                const profile: NostrProfile = { lud16: address };
                const result = await validator.validateWithDetails(profile);
                
                expect(result.validFormat).toBe(true);
                expect(result.address).toBe(address);
                expect(result.type).toBe('lud16');
            }
        });
    });
    
    describe('LNURL format validation', () => {
        it('should accept valid LNURL bech32 formats', async () => {
            const validLnurls = [
                'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
                'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr3jhg6',
                'LNURL1DP68GURN8GHJ7UM5WFHJKVT5WEX3EPP9MN7V5X5AURQ9X4VR', // Uppercase should work
            ];
            
            for (const lnurl of validLnurls) {
                const profile: NostrProfile = { lud06: lnurl };
                const result = await validator.validateWithDetails(profile);
                
                expect(result.validFormat).toBe(true);
                expect(result.address).toBe(lnurl);
                expect(result.type).toBe('lud06');
            }
        });
        
        it('should accept valid LNURL URL formats', async () => {
            const validUrls = [
                'https://example.com/lnurl',
                'https://domain.com/.well-known/lnurlp/user',
                'http://localhost:3000/lnurl',
            ];
            
            for (const url of validUrls) {
                const profile: NostrProfile = { lud06: url };
                const result = await validator.validateWithDetails(profile);
                
                expect(result.validFormat).toBe(true);
                expect(result.address).toBe(url);
                expect(result.type).toBe('lud06');
            }
        });
    });
    
    describe('connectivity checking', () => {
        beforeEach(() => {
            validator.updateConfig({ checkConnectivity: true });
        });
        
        it('should pass connectivity check for valid Lightning Address', async () => {
            const profile: NostrProfile = {
                lud16: 'user@example.com',
            };
            
            // Mock successful fetch
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
            } as Response);
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toBeUndefined();
            expect(mockFetch).toHaveBeenCalledWith(
                'https://example.com/.well-known/lnurlp/user',
                {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                }
            );
        });
        
        it('should fail connectivity check for unreachable domain', async () => {
            const profile: NostrProfile = {
                lud16: 'user@nonexistent-domain.com',
            };
            
            // Mock failed fetch
            mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND nonexistent-domain.com'));
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toContain('Connectivity check failed');
        });
        
        it('should handle timeout during connectivity check', async () => {
            const profile: NostrProfile = {
                lud16: 'user@example.com',
            };
            
            // Mock timeout
            mockFetch.mockRejectedValueOnce(new Error('timeout'));
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toContain('Connectivity check failed');
        });
    });
    
    describe('LNURL validation', () => {
        beforeEach(() => {
            validator.updateConfig({ validateLnurl: true });
        });
        
        it('should validate LNURL endpoint successfully', async () => {
            const profile: NostrProfile = {
                lud06: 'https://example.com/lnurl',
            };
            
            // Mock successful LNURL endpoint
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ status: 'OK' }),
            } as Response);
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toBeUndefined();
            expect(mockFetch).toHaveBeenCalledWith(
                'https://example.com/lnurl',
                {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                }
            );
        });
        
        it('should fail LNURL validation for invalid endpoint', async () => {
            const profile: NostrProfile = {
                lud06: 'https://example.com/lnurl',
            };
            
            // Mock failed LNURL endpoint
            mockFetch.mockRejectedValueOnce(new Error('404 Not Found'));
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toContain('LNURL validation failed');
        });
        
        it('should handle bech32 LNURL decoding error', async () => {
            const profile: NostrProfile = {
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const result = await validator.validateWithDetails(profile);
            
            expect(result.validFormat).toBe(true);
            expect(result.error).toContain('LNURL validation failed');
            expect(result.error).toContain('Bech32 LNURL decoding not implemented');
        });
    });
    
    describe('utility methods', () => {
        it('should get Lightning address when lud16 present', () => {
            const profile: NostrProfile = {
                lud16: 'user@example.com',
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const address = validator.getLightningAddress(profile);
            expect(address).toBe('user@example.com');
        });
        
        it('should get Lightning address when only lud06 present', () => {
            const profile: NostrProfile = {
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const address = validator.getLightningAddress(profile);
            expect(address).toBe('lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr');
        });
        
        it('should return null when no Lightning address present', () => {
            const profile: NostrProfile = {
                name: 'Test User',
            };
            
            const address = validator.getLightningAddress(profile);
            expect(address).toBeNull();
        });
        
        it('should get Lightning address type for lud16', () => {
            const profile: NostrProfile = {
                lud16: 'user@example.com',
            };
            
            const type = validator.getLightningAddressType(profile);
            expect(type).toBe('lud16');
        });
        
        it('should get Lightning address type for lud06', () => {
            const profile: NostrProfile = {
                lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr',
            };
            
            const type = validator.getLightningAddressType(profile);
            expect(type).toBe('lud06');
        });
        
        it('should return null when no Lightning address type', () => {
            const profile: NostrProfile = {
                name: 'Test User',
            };
            
            const type = validator.getLightningAddressType(profile);
            expect(type).toBeNull();
        });
        
        it('should check if profile has Lightning address', () => {
            const profileWithLud16: NostrProfile = { lud16: 'user@example.com' };
            const profileWithLud06: NostrProfile = { lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr' };
            const profileWithout: NostrProfile = { name: 'Test User' };
            
            expect(validator.hasLightningAddress(profileWithLud16)).toBe(true);
            expect(validator.hasLightningAddress(profileWithLud06)).toBe(true);
            expect(validator.hasLightningAddress(profileWithout)).toBe(false);
        });
    });
    
    describe('validateBatch', () => {
        it('should validate multiple profiles in parallel', async () => {
            const profiles: NostrProfile[] = [
                { lud16: 'user1@example.com' },
                { lud06: 'lnurl1dp68gurn8ghj7um5wfghjkvt5wex3epp9mn7v5x5aurq9x4vr' },
                { lud16: 'user3@example.com' },
            ];
            
            const results = await validator.validateBatch(profiles);
            
            expect(results).toHaveLength(3);
            expect(results[0]!.hasAddress).toBe(true);
            expect(results[0]!.type).toBe('lud16');
            expect(results[1]!.hasAddress).toBe(true);
            expect(results[1]!.type).toBe('lud06');
            expect(results[2]!.hasAddress).toBe(true);
            expect(results[2]!.type).toBe('lud16');
        });
        
        it('should handle mixed valid and invalid profiles', async () => {
            const profiles: NostrProfile[] = [
                { lud16: 'user@example.com' }, // Valid
                { lud16: 'invalid-address' }, // Invalid format
                { name: 'No Lightning' }, // No address
            ];
            
            const results = await validator.validateBatch(profiles);
            
            expect(results).toHaveLength(3);
            expect(results[0]!.hasAddress).toBe(true);
            expect(results[0]!.validFormat).toBe(true);
            expect(results[1]!.hasAddress).toBe(true);
            expect(results[1]!.validFormat).toBe(false);
            expect(results[2]!.hasAddress).toBe(false);
            expect(results[2]!.validFormat).toBe(false);
        });
        
        it('should handle errors in batch validation', async () => {
            const profiles: NostrProfile[] = [
                { lud16: 'user@example.com' },
                { lud16: 'user@error-domain.com' },
            ];
            
            // Mock error for second profile
            // Reset and configure mock for this test
            mockFetch.mockClear();
            mockFetch.mockImplementation(((input: any) => {
                const url = typeof input === 'string' ? input : input.toString();
                
                if (url.includes('error-domain.com')) {
                    return Promise.reject(new Error('Network error'));
                }
                
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                } as Response);
            }) as unknown as typeof fetch);
            
            validator.updateConfig({ checkConnectivity: true });
            
            const results = await validator.validateBatch(profiles);
            
            expect(results).toHaveLength(2);
            expect(results[0]!.validFormat).toBe(true);
            expect(results[1]!.validFormat).toBe(true);
            expect(results[1]!.error).toContain('Connectivity check failed');
        });
    });
    
    describe('configuration', () => {
        it('should use default configuration when none provided', () => {
            const defaultValidator = new LightningValidator();
            const config = defaultValidator.getConfig();
            
            expect(config.timeout).toBe(5000);
            expect(config.retries).toBe(2);
            expect(config.retryDelay).toBe(1000);
            expect(config.enableLogging).toBe(true);
            expect(config.validateLnurl).toBe(true);
            expect(config.checkConnectivity).toBe(false);
        });
        
        it('should merge custom configuration with defaults', () => {
            const customValidator = new LightningValidator({
                timeout: 10000,
                enableLogging: false,
                checkConnectivity: true,
            });
            
            const config = customValidator.getConfig();
            
            expect(config.timeout).toBe(10000);
            expect(config.retries).toBe(2); // Default value
            expect(config.enableLogging).toBe(false);
            expect(config.checkConnectivity).toBe(true);
        });
        
        it('should update configuration', () => {
            validator.updateConfig({
                timeout: 2000,
                retries: 5,
                validateLnurl: true,
            });
            
            const config = validator.getConfig();
            
            expect(config.timeout).toBe(2000);
            expect(config.retries).toBe(5);
            expect(config.validateLnurl).toBe(true);
            expect(config.enableLogging).toBe(false); // Previous value
        });
    });
});