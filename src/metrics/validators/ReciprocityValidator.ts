import { SimplePool } from 'nostr-tools/pool';
import type { SocialGraphManager } from '../../social-graph/SocialGraphManager';
import type { 
    ReciprocityResult,
    ValidatorConfig,
    MetricResult
} from '../types';
import { MetricsError, MetricsErrorCodes } from '../types';

/**
 * Reciprocity Validator for Nostr mutual follow validation
 * Checks if target pubkey follows source pubkey back (mutual follow)
 * Integrates with SocialGraphManager for optimized queries
 */
export class ReciprocityValidator {
    private pool: SimplePool;
    private relays: string[];
    private config: ValidatorConfig;
    private graphManager?: SocialGraphManager;
    
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
     * Check if target follows source back (reciprocity)
     * Prefers using social graph if available, otherwise queries relays
     */
    async checkReciprocity(sourcePubkey: string, targetPubkey: string): Promise<boolean> {
        try {
            const result = await this.validateReciprocity(sourcePubkey, targetPubkey);
            return result.isReciprocal;
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Reciprocity validation failed:`, error);
            }
            return false;
        }
    }
    
    /**
     * Validate reciprocity with detailed result
     */
    async validateReciprocity(sourcePubkey: string, targetPubkey: string): Promise<ReciprocityResult> {
        const startTime = Date.now();
        
        try {
            if (this.config.enableLogging) {
                console.log(`Reciprocity: Checking ${sourcePubkey.substring(0, 8)}... ↔ ${targetPubkey.substring(0, 8)}...`);
            }
            
            // First try using social graph if available
            if (this.graphManager && this.graphManager.isManagerInitialized()) {
                return this.checkReciprocityViaGraph(sourcePubkey, targetPubkey);
            }
            
            // Otherwise, query relays for follow lists
            return this.checkReciprocityViaRelay(sourcePubkey, targetPubkey);
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            if (this.config.enableLogging) {
                console.log(`Reciprocity: Failed (${duration}ms) - ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            
            // Handle timeout specifically
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new MetricsError(
                    `Reciprocity validation timeout`,
                    MetricsErrorCodes.TIMEOUT_ERROR,
                    'reciprocity',
                    targetPubkey
                );
            }
            
            // Handle network errors
            if (error instanceof Error && (
                error.message.includes('ENOTFOUND') ||
                error.message.includes('ECONNREFUSED') ||
                error.message.includes('fetch')
            )) {
                throw new MetricsError(
                    `Reciprocity network error: ${error.message}`,
                    MetricsErrorCodes.NETWORK_ERROR,
                    'reciprocity',
                    targetPubkey
                );
            }
            
            throw new MetricsError(
                `Reciprocity validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                MetricsErrorCodes.VALIDATION_ERROR,
                'reciprocity',
                targetPubkey
            );
        }
    }
    
    /**
     * Check reciprocity using social graph (optimized)
     */
    private async checkReciprocityViaGraph(
        sourcePubkey: string,
        targetPubkey: string
    ): Promise<ReciprocityResult> {
        if (!this.graphManager) {
            throw new Error('Social graph manager not available');
        }
        
        const startTime = Date.now();
        
        // Check if pubkeys exist in the graph
        const sourceInGraph = this.graphManager.isInGraph(sourcePubkey);
        const targetInGraph = this.graphManager.isInGraph(targetPubkey);
        
        if (!sourceInGraph || !targetInGraph) {
            const duration = Date.now() - startTime;
            
            if (this.config.enableLogging) {
                console.log(`Reciprocity: Pubkeys not in graph (${duration}ms) - source: ${sourceInGraph}, target: ${targetInGraph}`);
            }
            
            return {
                isReciprocal: false,
                sourceFollowsTarget: false,
                targetFollowsSource: false,
                sourceInGraph,
                targetInGraph,
                verifiedAt: Math.floor(Date.now() / 1000),
            };
        }
        
        // Check follow relationships
        const sourceFollowsTarget = this.graphManager.isFollowing(sourcePubkey, targetPubkey);
        const targetFollowsSource = this.graphManager.isFollowing(targetPubkey, sourcePubkey);
        const isReciprocal = sourceFollowsTarget && targetFollowsSource;
        
        const duration = Date.now() - startTime;
        
        if (this.config.enableLogging) {
            console.log(
                `Reciprocity: ${isReciprocal ? '✓' : '✗'} (${duration}ms) - ` +
                `source→target: ${sourceFollowsTarget}, target→source: ${targetFollowsSource}`
            );
        }
        
        return {
            isReciprocal,
            sourceFollowsTarget,
            targetFollowsSource,
            sourceInGraph,
            targetInGraph,
            verifiedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Check reciprocity by querying relays (fallback)
     */
    private async checkReciprocityViaRelay(
        sourcePubkey: string,
        targetPubkey: string
    ): Promise<ReciprocityResult> {
        const startTime = Date.now();
        
        // Query both follow lists in parallel
        const [sourceFollowsTarget, targetFollowsSource] = await Promise.all([
            this.checkFollowViaRelay(sourcePubkey, targetPubkey),
            this.checkFollowViaRelay(targetPubkey, sourcePubkey),
        ]);
        
        const isReciprocal = sourceFollowsTarget && targetFollowsSource;
        const duration = Date.now() - startTime;
        
        if (this.config.enableLogging) {
            console.log(
                `Reciprocity: ${isReciprocal ? '✓' : '✗'} (${duration}ms) - ` +
                `source→target: ${sourceFollowsTarget}, target→source: ${targetFollowsSource}`
            );
        }
        
        return {
            isReciprocal,
            sourceFollowsTarget,
            targetFollowsSource,
            sourceInGraph: false, // Not using graph
            targetInGraph: false, // Not using graph
            verifiedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Check if source follows target by querying relays
     */
    private async checkFollowViaRelay(sourcePubkey: string, targetPubkey: string): Promise<boolean> {
        try {
            // Get source's follow list (kind 3)
            const followList = await this.withTimeout(
                this.pool.get(this.relays, {
                    kinds: [3],
                    authors: [sourcePubkey],
                }),
                this.config.timeout
            );
            
            if (!followList) {
                return false;
            }
            
            // Check if target is in source's follow list
            const follows = followList.tags
                .filter(tag => tag[0] === 'p')
                .map(tag => tag[1]);
            
            return follows.includes(targetPubkey);
            
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Failed to check follow relationship via relay:`, error);
            }
            return false;
        }
    }
    
    /**
     * Check if source follows target (simplified interface)
     */
    async isFollowing(sourcePubkey: string, targetPubkey: string): Promise<boolean> {
        try {
            // First try using social graph if available
            if (this.graphManager && this.graphManager.isManagerInitialized()) {
                const sourceInGraph = this.graphManager.isInGraph(sourcePubkey);
                const targetInGraph = this.graphManager.isInGraph(targetPubkey);
                
                if (sourceInGraph && targetInGraph) {
                    return this.graphManager.isFollowing(sourcePubkey, targetPubkey);
                }
            }
            
            // Otherwise, query relays
            return this.checkFollowViaRelay(sourcePubkey, targetPubkey);
            
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Failed to check follow relationship:`, error);
            }
            return false;
        }
    }
    
    /**
     * Batch validate reciprocity for multiple pubkey pairs
     */
    async validateBatch(pairs: Array<{ sourcePubkey: string; targetPubkey: string }>): Promise<ReciprocityResult[]> {
        if (this.config.enableLogging) {
            console.log(`Reciprocity: Batch validating ${pairs.length} pubkey pairs`);
        }
        
        // Process in parallel with concurrency limit
        const concurrencyLimit = 5;
        const chunks = this.chunkArray(pairs, concurrencyLimit);
        
        const results: ReciprocityResult[] = [];
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async ({ sourcePubkey, targetPubkey }) => {
                try {
                    return await this.validateReciprocity(sourcePubkey, targetPubkey);
                } catch (error) {
                    return {
                        isReciprocal: false,
                        sourceFollowsTarget: false,
                        targetFollowsSource: false,
                        sourceInGraph: false,
                        targetInGraph: false,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        verifiedAt: Math.floor(Date.now() / 1000),
                    } as ReciprocityResult;
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
        }
        
        if (this.config.enableLogging) {
            const reciprocalCount = results.filter(r => r.isReciprocal).length;
            console.log(`Reciprocity: Batch validation complete - ${reciprocalCount}/${pairs.length} pairs are reciprocal`);
        }
        
        return results;
    }
    
    /**
     * Get follow list for a pubkey
     */
    async getFollowList(pubkey: string): Promise<string[]> {
        try {
            if (this.config.enableLogging) {
                console.log(`Reciprocity: Getting follow list for ${pubkey.substring(0, 8)}...`);
            }
            
            // First try using social graph if available
            if (this.graphManager && this.graphManager.isManagerInitialized()) {
                // This is a simplified approach - in practice, you'd need to implement
                // a method in SocialGraphManager to get the follow list
                // For now, we'll fall back to relay queries
            }
            
            // Query relays for follow list
            const followList = await this.withTimeout(
                this.pool.get(this.relays, {
                    kinds: [3],
                    authors: [pubkey],
                }),
                this.config.timeout
            );
            
            if (!followList) {
                return [];
            }
            
            const follows = followList.tags
                .filter(tag => tag[0] === 'p')
                .map(tag => tag[1])
                .filter((pubkey): pubkey is string => pubkey !== undefined);
            
            if (this.config.enableLogging) {
                console.log(`Reciprocity: Found ${follows.length} follows for ${pubkey.substring(0, 8)}...`);
            }
            
            return follows;
            
        } catch (error) {
            if (this.config.enableLogging) {
                console.error(`Failed to get follow list for ${pubkey}:`, error);
            }
            return [];
        }
    }
    
    /**
     * Set social graph manager for optimized queries
     */
    setGraphManager(graphManager: SocialGraphManager): void {
        this.graphManager = graphManager;
        
        if (this.config.enableLogging) {
            console.log('Reciprocity: Social graph manager set for optimized queries');
        }
    }
    
    /**
     * Remove social graph manager
     */
    removeGraphManager(): void {
        this.graphManager = undefined;
        
        if (this.config.enableLogging) {
            console.log('Reciprocity: Social graph manager removed - using relay queries only');
        }
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
                    console.log(`Reciprocity: Retry ${attempt + 1}/${retries} after ${delay}ms - ${lastError.message}`);
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
    
    /**
     * Check if social graph manager is available
     */
    hasGraphManager(): boolean {
        return this.graphManager !== undefined && this.graphManager.isManagerInitialized();
    }
}