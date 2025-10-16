import type { 
    NostrProfile, 
    LightningResult, 
    LightningValidatorConfig, 
    MetricResult
} from '../types';
import { MetricsError, MetricsErrorCodes } from '../types';

/**
 * Lightning Validator for Nostr Lightning Network addresses
 * Detects and validates lud16 (Lightning Address) and lud06 (LNURL) formats
 */
export class LightningValidator {
    private config: LightningValidatorConfig;
    
    constructor(config?: Partial<LightningValidatorConfig>) {
        this.config = {
            timeout: 5000,
            retries: 2,
            retryDelay: 1000,
            enableLogging: true,
            validateLnurl: true,
            checkConnectivity: false, // Default to false for performance
            ...config,
        };
    }
    
    /**
     * Validate Lightning address in a profile
     * Returns true if valid Lightning address is present
     */
    async validate(profile: NostrProfile): Promise<boolean> {
        try {
            const result = await this.validateWithDetails(profile);
            return result.hasAddress && result.validFormat;
        } catch (error) {
            if (this.config.enableLogging) {
                console.error('Lightning validation failed:', error);
            }
            return false;
        }
    }
    
    /**
     * Validate Lightning address with detailed result
     * Performs format validation and optional connectivity testing
     */
    async validateWithDetails(profile: NostrProfile): Promise<LightningResult> {
        const startTime = Date.now();
        
        try {
            // Check for lud16 (Lightning Address format) first
            if (profile.lud16) {
                const result = await this.validateLightningAddress(profile.lud16, 'lud16');
                const duration = Date.now() - startTime;
                
                if (this.config.enableLogging) {
                    console.log(`Lightning: lud16 ${profile.lud16} ${result.validFormat ? '✓' : '✗'} (${duration}ms)`);
                }
                
                return result;
            }
            
            // Check for lud06 (LNURL format)
            if (profile.lud06) {
                const result = await this.validateLnurl(profile.lud06);
                const duration = Date.now() - startTime;
                
                if (this.config.enableLogging) {
                    console.log(`Lightning: lud06 ${profile.lud06.substring(0, 20)}... ${result.validFormat ? '✓' : '✗'} (${duration}ms)`);
                }
                
                return result;
            }
            
            // No Lightning address found
            return {
                hasAddress: false,
                validFormat: false,
                verifiedAt: Math.floor(Date.now() / 1000),
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            if (this.config.enableLogging) {
                console.log(`Lightning: Validation failed (${duration}ms) - ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            
            // Handle timeout specifically
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new MetricsError(
                    `Lightning validation timeout`,
                    MetricsErrorCodes.TIMEOUT_ERROR,
                    'lightning'
                );
            }
            
            // Handle network errors
            if (error instanceof Error && (
                error.message.includes('ENOTFOUND') ||
                error.message.includes('ECONNREFUSED') ||
                error.message.includes('fetch')
            )) {
                throw new MetricsError(
                    `Lightning network error: ${error.message}`,
                    MetricsErrorCodes.NETWORK_ERROR,
                    'lightning'
                );
            }
            
            throw new MetricsError(
                `Lightning validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.LIGHTNING_VALIDATION_FAILED,
                'lightning'
            );
        }
    }
    
    /**
     * Validate Lightning Address format (user@domain.com)
     */
    private async validateLightningAddress(
        address: string, 
        type: 'lud16'
    ): Promise<LightningResult> {
        // Basic format validation
        if (!this.isValidLightningAddressFormat(address)) {
            return {
                hasAddress: true,
                address,
                type,
                validFormat: false,
                error: 'Invalid Lightning Address format',
                verifiedAt: Math.floor(Date.now() / 1000),
            };
        }
        
        // Optional connectivity check
        if (this.config.checkConnectivity) {
            try {
                await this.checkLightningAddressConnectivity(address);
            } catch (error) {
                return {
                    hasAddress: true,
                    address,
                    type,
                    validFormat: true,
                    error: `Connectivity check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    verifiedAt: Math.floor(Date.now() / 1000),
                };
            }
        }
        
        return {
            hasAddress: true,
            address,
            type,
            validFormat: true,
            verifiedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Validate LNURL format
     */
    private async validateLnurl(lnurl: string): Promise<LightningResult> {
        // Basic LNURL format validation
        if (!this.isValidLnurlFormat(lnurl)) {
            return {
                hasAddress: true,
                address: lnurl,
                type: 'lud06',
                validFormat: false,
                error: 'Invalid LNURL format',
                verifiedAt: Math.floor(Date.now() / 1000),
            };
        }
        
        // Optional LNURL validation
        if (this.config.validateLnurl) {
            try {
                await this.validateLnurlEndpoint(lnurl);
            } catch (error) {
                return {
                    hasAddress: true,
                    address: lnurl,
                    type: 'lud06',
                    validFormat: true,
                    error: `LNURL validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    verifiedAt: Math.floor(Date.now() / 1000),
                };
            }
        }
        
        return {
            hasAddress: true,
            address: lnurl,
            type: 'lud06',
            validFormat: true,
            verifiedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Validate Lightning Address format (user@domain.com)
     */
    private isValidLightningAddressFormat(address: string): boolean {
        if (!address || typeof address !== 'string') {
            return false;
        }
        
        // Basic email-like format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(address)) {
            return false;
        }
        
        // Additional checks
        const parts = address.split('@');
        if (parts.length !== 2) {
            return false;
        }
        
        const [local, domain] = parts;
        
        // Local part validation (username)
        if (!local || local.length === 0 || local.length > 64) {
            return false;
        }
        
        // Domain part validation
        if (!domain || domain.length === 0 || domain.length > 253) {
            return false;
        }
        
        // Check for valid domain characters
        const domainRegex = /^[a-zA-Z0-9.-]+$/;
        if (!domainRegex.test(domain)) {
            return false;
        }
        
        // Domain shouldn't start or end with dot or dash
        if (domain.startsWith('.') || domain.endsWith('.') || 
            domain.startsWith('-') || domain.endsWith('-')) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Validate LNURL format
     */
    private isValidLnurlFormat(lnurl: string): boolean {
        if (!lnurl || typeof lnurl !== 'string') {
            return false;
        }
        
        // Check if it's a bech32 encoded LNURL
        if (lnurl.toLowerCase().startsWith('lnurl')) {
            // Basic bech32 format check
            const bech32Regex = /^lnurl1[ac-hj-np-z02-9]{8,}$/;
            return bech32Regex.test(lnurl.toLowerCase());
        }
        
        // Check if it's a URL format
        try {
            const url = new URL(lnurl);
            return url.protocol === 'https:' || url.protocol === 'http:';
        } catch {
            return false;
        }
    }
    
    /**
     * Check Lightning Address connectivity (optional)
     * This would typically involve fetching the LNURL from the domain
     */
    private async checkLightningAddressConnectivity(address: string): Promise<void> {
        const [username, domain] = address.split('@');
        const lnurlUrl = `https://${domain}/.well-known/lnurlp/${username}`;
        
        await this.withTimeout(
            fetch(lnurlUrl, { 
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }),
            this.config.timeout
        );
    }
    
    /**
     * Validate LNURL endpoint (optional)
     */
    private async validateLnurlEndpoint(lnurl: string): Promise<void> {
        if (lnurl.toLowerCase().startsWith('lnurl')) {
            // For bech32 encoded LNURLs, we'd need to decode them first
            // This is a simplified implementation
            throw new Error('Bech32 LNURL decoding not implemented in this validator');
        }
        
        // For URL format LNURLs, fetch the endpoint
        await this.withTimeout(
            fetch(lnurl, { 
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }),
            this.config.timeout
        );
    }
    
    /**
     * Execute a promise with timeout
     */
    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        
        return Promise.race([promise, timeoutPromise]);
    }
    
    /**
     * Get the Lightning address if present
     */
    getLightningAddress(profile: NostrProfile): string | null {
        return profile.lud16 || profile.lud06 || null;
    }
    
    /**
     * Get Lightning address type
     */
    getLightningAddressType(profile: NostrProfile): 'lud16' | 'lud06' | null {
        if (profile.lud16) return 'lud16';
        if (profile.lud06) return 'lud06';
        return null;
    }
    
    /**
     * Check if profile has any Lightning address
     */
    hasLightningAddress(profile: NostrProfile): boolean {
        return !!(profile.lud16 || profile.lud06);
    }
    
    /**
     * Batch validate multiple profiles
     */
    async validateBatch(profiles: NostrProfile[]): Promise<LightningResult[]> {
        const results: LightningResult[] = [];
        
        // Process in parallel with concurrency limit
        const concurrencyLimit = 10;
        const chunks = this.chunkArray(profiles, concurrencyLimit);
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async (profile) => {
                try {
                    return await this.validateWithDetails(profile);
                } catch (error) {
                    const address = this.getLightningAddress(profile);
                    return {
                        hasAddress: !!address,
                        address: address || undefined,
                        type: this.getLightningAddressType(profile) || undefined,
                        validFormat: false,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        verifiedAt: Math.floor(Date.now() / 1000),
                    } as LightningResult;
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
        }
        
        return results;
    }
    
    /**
     * Utility: Split array into chunks
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }
    
    /**
     * Get validator configuration
     */
    getConfig(): LightningValidatorConfig {
        return { ...this.config };
    }
    
    /**
     * Update validator configuration
     */
    updateConfig(config: Partial<LightningValidatorConfig>): void {
        this.config = { ...this.config, ...config };
    }
}