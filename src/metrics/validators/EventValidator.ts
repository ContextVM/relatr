import { SimplePool } from 'nostr-tools/pool';
import type { 
    EventResult,
    ValidatorConfig,
    MetricResult
} from '../types';
import { MetricsError, MetricsErrorCodes } from '../types';

/**
 * Event Validator for Nostr event kind validation
 * Checks for presence of specific event kinds (e.g., kind 10002 relay list metadata)
 */
export class EventValidator {
    private pool: SimplePool;
    private relays: string[];
    private config: ValidatorConfig;
    
    constructor(pool: SimplePool, relays: string[], config?: Partial<ValidatorConfig>) {
        this.pool = pool;
        this.relays = relays;
        this.config = {
            timeout: 5000,
            retries: 2,
            retryDelay: 1000,
            enableLogging: true,
            ...config,
        };
    }
    
    /**
     * Check if pubkey has published an event of specific kind
     */
    async hasEventKind(pubkey: string, kind: number): Promise<boolean> {
        try {
            const result = await this.validateEventKind(pubkey, kind);
            return result.hasEvent;
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Event validation failed for kind ${kind}:`, error);
            }
            return false;
        }
    }
    
    /**
     * Validate event kind with detailed result
     */
    async validateEventKind(pubkey: string, kind: number): Promise<EventResult> {
        const startTime = Date.now();
        
        try {
            if (this.config.enableLogging) {
                console.log(`Event: Checking for kind ${kind} from pubkey ${pubkey.substring(0, 8)}...`);
            }
            
            // Query for the event with timeout
            const event = await this.withTimeout(
                this.pool.get(this.relays, {
                    kinds: [kind],
                    authors: [pubkey],
                    limit: 1,
                }),
                this.config.timeout
            );
            
            const duration = Date.now() - startTime;
            
            if (!event) {
                if (this.config.enableLogging) {
                    console.log(`Event: No kind ${kind} found (${duration}ms)`);
                }
                
                return {
                    hasEvent: false,
                    eventKind: kind,
                    verifiedAt: Math.floor(Date.now() / 1000),
                };
            }
            
            if (this.config.enableLogging) {
                console.log(`Event: Found kind ${kind} (${duration}ms) - ${event.id.substring(0, 8)}...`);
            }
            
            return {
                hasEvent: true,
                eventKind: kind,
                eventId: event.id,
                eventContent: event.content,
                eventCreatedAt: event.created_at,
                verifiedAt: Math.floor(Date.now() / 1000),
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            if (this.config.enableLogging) {
                console.log(`Event: Failed to check kind ${kind} (${duration}ms) - ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            
            // Handle timeout specifically
            if (error instanceof Error && (error.message.includes('timeout') || error.message.includes('timed out'))) {
                throw new MetricsError(
                    `Event validation timeout for kind ${kind}`,
                    MetricsErrorCodes.TIMEOUT_ERROR,
                    'event',
                    pubkey
                );
            }
            
            // Handle network errors
            if (error instanceof Error && (
                error.message.includes('ENOTFOUND') ||
                error.message.includes('ECONNREFUSED') ||
                error.message.includes('fetch')
            )) {
                throw new MetricsError(
                    `Event network error for kind ${kind}: ${error.message}`,
                    MetricsErrorCodes.NETWORK_ERROR,
                    'event',
                    pubkey
                );
            }
            
            throw new MetricsError(
                `Event validation failed for kind ${kind}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.VALIDATION_ERROR,
                'event',
                pubkey
            );
        }
    }
    
    /**
     * Check for relay list metadata (kind 10002)
     */
    async hasRelayListMetadata(pubkey: string): Promise<boolean> {
        return this.hasEventKind(pubkey, 10002);
    }
    
    /**
     * Validate relay list metadata with detailed result
     */
    async validateRelayListMetadata(pubkey: string): Promise<EventResult> {
        return this.validateEventKind(pubkey, 10002);
    }
    
    /**
     * Get all event kinds published by a pubkey
     */
    async getPublishedEventKinds(pubkey: string): Promise<number[]> {
        try {
            if (this.config.enableLogging) {
                console.log(`Event: Getting all event kinds for pubkey ${pubkey.substring(0, 8)}...`);
            }
            
            const events = await this.withTimeout(
                this.pool.querySync(this.relays, {
                    authors: [pubkey],
                    limit: 100,
                }),
                this.config.timeout
            );
            
            const kinds = new Set<number>();
            for (const event of events) {
                kinds.add(event.kind);
            }
            
            const kindArray = Array.from(kinds);
            
            if (this.config.enableLogging) {
                console.log(`Event: Found ${kindArray.length} different event kinds: [${kindArray.join(', ')}]`);
            }
            
            return kindArray;
            
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Failed to get event kinds for ${pubkey}:`, error);
            }
            return [];
        }
    }
    
    /**
     * Check for multiple event kinds at once
     */
    async checkMultipleEventKinds(pubkey: string, kinds: number[]): Promise<EventResult[]> {
        if (this.config.enableLogging) {
            console.log(`Event: Checking for ${kinds.length} event kinds for pubkey ${pubkey.substring(0, 8)}...`);
        }
        
        // Process in parallel for better performance
        const promises = kinds.map(kind => this.validateEventKind(pubkey, kind));
        
        try {
            const results = await Promise.all(promises);
            
            if (this.config.enableLogging) {
                const foundCount = results.filter(r => r.hasEvent).length;
                console.log(`Event: Found ${foundCount}/${kinds.length} event kinds`);
            }
            
            return results;
            
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Failed to check multiple event kinds:`, error);
            }
            
            // Return error results for all kinds
            return kinds.map(kind => ({
                hasEvent: false,
                eventKind: kind,
                error: error instanceof Error ? error.message : 'Unknown error',
                verifiedAt: Math.floor(Date.now() / 1000),
            }));
        }
    }
    
    /**
     * Batch validate event kinds for multiple pubkeys
     */
    async validateBatch(pubkeys: string[], kind: number): Promise<EventResult[]> {
        if (this.config.enableLogging) {
            console.log(`Event: Batch validating kind ${kind} for ${pubkeys.length} pubkeys`);
        }
        
        // Process in parallel with concurrency limit
        const concurrencyLimit = 5;
        const chunks = this.chunkArray(pubkeys, concurrencyLimit);
        
        const results: EventResult[] = [];
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async (pubkey) => {
                try {
                    return await this.validateEventKind(pubkey, kind);
                } catch (error) {
                    return {
                        hasEvent: false,
                        eventKind: kind,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        verifiedAt: Math.floor(Date.now() / 1000),
                    } as EventResult;
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
        }
        
        if (this.config.enableLogging) {
            const foundCount = results.filter(r => r.hasEvent).length;
            console.log(`Event: Batch validation complete - ${foundCount}/${pubkeys.length} pubkeys have kind ${kind}`);
        }
        
        return results;
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
                    console.log(`Event: Retry ${attempt + 1}/${retries} after ${delay}ms - ${lastError.message}`);
                }
                
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
            }
        }
        
        throw lastError!;
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
    getConfig(): ValidatorConfig {
        return { ...this.config };
    }
    
    /**
     * Update validator configuration
     */
    updateConfig(config: Partial<ValidatorConfig>): void {
        this.config = { ...this.config, ...config };
    }
    
    /**
     * Get relays used by this validator
     */
    getRelays(): string[] {
        return [...this.relays];
    }
    
    /**
     * Update relays used by this validator
     */
    updateRelays(relays: string[]): void {
        this.relays = [...relays];
    }
}