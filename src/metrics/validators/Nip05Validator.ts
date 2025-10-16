import { queryProfile } from 'nostr-tools/nip05';
import type {
    NostrProfile,
    Nip05Result,
    Nip05ValidatorConfig,
    MetricResult
} from '../types';
import { MetricsError, MetricsErrorCodes } from '../types';

/**
 * NIP-05 Validator for Nostr identity verification
 * Uses nostr-tools/nip05 for DNS resolution and verification
 */
export class Nip05Validator {
    private config: Nip05ValidatorConfig;
    
    constructor(config?: Partial<Nip05ValidatorConfig>) {
        this.config = {
            timeout: 5000,
            retries: 2,
            retryDelay: 1000,
            enableLogging: true,
            wellKnownTimeout: 3000,
            verifySignature: true,
            ...config,
        };
    }
    
    /**
     * Validate NIP-05 identifier in a profile
     * Returns true if valid and verified against the pubkey
     */
    async validate(profile: NostrProfile, pubkey: string): Promise<boolean> {
        if (!profile.nip05) {
            if (this.config.enableLogging) {
                console.log('NIP-05: No nip05 field in profile');
            }
            return false;
        }
        
        try {
            const result = await this.validateWithPubkey(profile.nip05, pubkey);
            return result.valid;
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`NIP-05 validation failed for ${profile.nip05}:`, error);
            }
            return false;
        }
    }
    
    /**
     * Validate NIP-05 identifier with explicit pubkey verification
     * Performs DNS resolution and pubkey matching
     */
    async validateWithPubkey(nip05: string, expectedPubkey: string): Promise<Nip05Result> {
        const startTime = Date.now();
        
        try {
            // Normalize domain-only NIP-05 (e.g., "dergigi.com" -> "_@dergigi.com")
            const normalizedNip05 = this.normalizeNip05(nip05);
            
            // Basic format validation
            if (!this.isValidNip05Format(normalizedNip05)) {
                throw new MetricsError(
                    `Invalid NIP-05 format: ${nip05}`,
                    MetricsErrorCodes.NIP05_VERIFICATION_FAILED,
                    'nip05',
                    expectedPubkey
                );
            }
            
            // Extract domain for logging
            const domain = normalizedNip05.split('@')[1];
            
            if (this.config.enableLogging) {
                console.log(`NIP-05: Validating ${nip05} (normalized: ${normalizedNip05}) against pubkey ${expectedPubkey.substring(0, 8)}...`);
            }
            
            // Query the NIP-05 address with timeout
            const profile = await this.withTimeout(
                queryProfile(normalizedNip05),
                this.config.wellKnownTimeout
            );
            
            if (!profile) {
                throw new MetricsError(
                    `No profile found for NIP-05: ${nip05}`,
                    MetricsErrorCodes.NIP05_VERIFICATION_FAILED,
                    'nip05',
                    expectedPubkey
                );
            }
            
            if (!profile.pubkey) {
                throw new MetricsError(
                    `No pubkey in NIP-05 response for: ${nip05}`,
                    MetricsErrorCodes.NIP05_VERIFICATION_FAILED,
                    'nip05',
                    expectedPubkey
                );
            }
            
            // Verify pubkey matches
            const isValid = profile.pubkey === expectedPubkey;
            
            const result: Nip05Result = {
                valid: isValid,
                nip05, // Keep original nip05 for consistency
                pubkey: profile.pubkey,
                domain,
                verifiedAt: Math.floor(Date.now() / 1000),
            };
            
            if (this.config.enableLogging) {
                const duration = Date.now() - startTime;
                console.log(
                    `NIP-05: ${nip05} ${isValid ? '✓' : '✗'} (${duration}ms) ` +
                    `${isValid ? '' : `(expected: ${expectedPubkey.substring(0, 8)}..., got: ${profile.pubkey.substring(0, 8)}...)`}`
                );
            }
            
            return result;
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            if (this.config.enableLogging) {
                console.log(`NIP-05: Failed ${nip05} (${duration}ms) - ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            
            // Re-throw MetricsError as-is, wrap others
            if (error instanceof MetricsError) {
                throw error;
            }
            
            // Handle timeout specifically
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new MetricsError(
                    `NIP-05 validation timeout for: ${nip05}`,
                    MetricsErrorCodes.NIP05_TIMEOUT,
                    'nip05',
                    expectedPubkey
                );
            }
            
            // Handle network/domain errors
            if (error instanceof Error && (
                error.message.includes('ENOTFOUND') ||
                error.message.includes('ECONNREFUSED') ||
                error.message.includes('fetch')
            )) {
                throw new MetricsError(
                    `NIP-05 domain error for: ${nip05} - ${error.message}`,
                    MetricsErrorCodes.NIP05_DOMAIN_ERROR,
                    'nip05',
                    expectedPubkey
                );
            }
            
            throw new MetricsError(
                `NIP-05 validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.NIP05_VERIFICATION_FAILED,
                'nip05',
                expectedPubkey
            );
        }
    }
    
    /**
     * Normalize NIP-05 identifier
     * Converts domain-only identifiers (e.g., "dergigi.com") to "_@dergigi.com"
     */
    private normalizeNip05(nip05: string): string {
        if (!nip05 || typeof nip05 !== 'string') {
            return nip05;
        }
        
        // If it doesn't contain an @ symbol, it's a domain-only identifier
        if (!nip05.includes('@')) {
            return `_@${nip05}`;
        }
        
        return nip05;
    }
    
    /**
     * Validate NIP-05 format (basic email-like validation)
     */
    private isValidNip05Format(nip05: string): boolean {
        if (!nip05 || typeof nip05 !== 'string') {
            return false;
        }
        
        // Basic email-like format: local@domain
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(nip05)) {
            return false;
        }
        
        // Additional checks
        const parts = nip05.split('@');
        if (parts.length !== 2) {
            return false;
        }
        
        const local = parts[0];
        const domain = parts[1];
        
        // Local part validation
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
     * Execute a promise with timeout
     */
    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        
        return Promise.race([promise, timeoutPromise]);
    }
    
    /**
     * Retry an operation with exponential backoff
     */
    private async withRetry<T>(
        operation: () => Promise<T>,
        retries: number = this.config.retries,
        delay: number = this.config.retryDelay
    ): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                
                if (attempt === retries) {
                    throw lastError;
                }
                
                if (this.config.enableLogging) {
                    console.log(`NIP-05: Retry ${attempt + 1}/${retries} after ${delay}ms - ${lastError.message}`);
                }
                
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
            }
        }
        
        throw lastError!;
    }
    
    /**
     * Batch validate multiple NIP-05 addresses
     */
    async validateBatch(
        entries: Array<{ nip05: string; pubkey: string }>
    ): Promise<Nip05Result[]> {
        const results: Nip05Result[] = [];
        
        // Process in parallel with concurrency limit
        const concurrencyLimit = 5;
        const chunks = this.chunkArray(entries, concurrencyLimit);
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async ({ nip05, pubkey }) => {
                try {
                    return await this.validateWithPubkey(nip05, pubkey);
                } catch (error) {
                    return {
                        valid: false,
                        nip05,
                        pubkey,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        verifiedAt: Math.floor(Date.now() / 1000),
                    } as Nip05Result;
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
    getConfig(): Nip05ValidatorConfig {
        return { ...this.config };
    }
    
    /**
     * Update validator configuration
     */
    updateConfig(config: Partial<Nip05ValidatorConfig>): void {
        this.config = { ...this.config, ...config };
    }
}