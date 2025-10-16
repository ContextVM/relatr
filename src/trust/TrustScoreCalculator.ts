import { Database } from 'bun:sqlite';
import type { 
    WeightingScheme, 
    MetricInputs, 
    TrustScoreResult, 
    TrustScoreConfig,
    MetricBreakdown,
    MetricValidationResult,
    TrustScoreError,
    CalculationOptions,
    BatchCalculationRequest,
    BatchCalculationResult
} from './types';
import { DefaultWeightingScheme, validateWeightingScheme } from './WeightingScheme';
import { TrustScoreCache } from './TrustScoreCache';

/**
 * Main class for computing trust scores
 */
export class TrustScoreCalculator {
    private db?: Database;
    private scheme: WeightingScheme;
    private cache?: TrustScoreCache;
    
    constructor(config?: TrustScoreConfig, db?: Database) {
        this.scheme = config?.weightingScheme || DefaultWeightingScheme;
        this.db = db;
        
        // Validate the weighting scheme
        const errors = validateWeightingScheme(this.scheme);
        if (errors.length > 0) {
            throw new Error(`Invalid weighting scheme: ${errors.join(', ')}`);
        }
        
        if (config?.cacheResults && db) {
            this.cache = new TrustScoreCache(
                db,
                config.cacheTtlSeconds || 3600
            );
        }
    }
    
    /**
     * Calculate trust score from metric inputs
     * 
     * @param inputs - All metric values (normalized to [0,1])
     * @param sourcePubkey - Optional source for caching
     * @param targetPubkey - Optional target for caching
     * @param options - Calculation options
     * @returns Trust score result
     */
    async calculate(
        inputs: MetricInputs,
        sourcePubkey?: string,
        targetPubkey?: string,
        options?: CalculationOptions
    ): Promise<TrustScoreResult> {
        // Validate inputs if requested
        if (options?.validateInputs !== false) {
            const validation = this.validateInputs(inputs);
            if (!validation.isValid) {
                const error = new Error(`Invalid metric inputs: ${validation.errors.join(', ')}`) as TrustScoreError;
                error.code = 'INVALID_INPUTS';
                throw error;
            }
        }
        
        // Try cache first if enabled and not forcing refresh
        if (this.cache && sourcePubkey && targetPubkey && !options?.forceRefresh) {
            const cached = await this.cache.get(sourcePubkey, targetPubkey);
            if (cached) {
                return cached;
            }
        }
        
        // Calculate weighted sum
        const result = this.computeScore(inputs);
        
        // Cache if enabled
        if (this.cache && sourcePubkey && targetPubkey) {
            await this.cache.save(sourcePubkey, targetPubkey, result);
        }
        
        return result;
    }
    
    /**
     * Compute the trust score using the weighted formula
     */
    private computeScore(inputs: MetricInputs): TrustScoreResult {
        let weightedSum = 0;
        let totalWeight = 0;
        
        const metricValues: Record<string, number> = {};
        const metricWeights: Record<string, number> = {};
        
        // Process each metric
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            const value = (inputs as any)[metricName];
            
            // Skip if value is undefined or metric is disabled
            if (value === undefined || !config.enabled) {
                continue;
            }
            
            // Validate value is in [0,1]
            if (value < 0 || value > 1 || !isFinite(value)) {
                throw new Error(
                    `Metric ${metricName} value ${value} is out of range [0,1] or invalid`
                );
            }
            
            // Apply exponent (v_i^p_i)
            const transformedValue = Math.pow(value, config.exponent);
            
            // Apply weight (w_i × v_i^p_i)
            const contribution = config.weight * transformedValue;
            
            weightedSum += contribution;
            totalWeight += config.weight;
            
            // Store for result
            metricValues[metricName] = value;
            metricWeights[metricName] = config.weight;
        }
        
        // Avoid division by zero
        if (totalWeight === 0) {
            return {
                score: 0,
                metricValues,
                metricWeights,
                computedAt: Math.floor(Date.now() / 1000),
            };
        }
        
        // Calculate final score (normalized)
        const score = weightedSum / totalWeight;
        
        return {
            score: Math.max(0, Math.min(1, score)), // Clamp to [0,1]
            metricValues,
            metricWeights,
            computedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Validate metric inputs
     */
    validateInputs(inputs: MetricInputs): MetricValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // Check that at least one metric is provided
        const hasAnyMetric = Object.keys(this.scheme.metrics).some(
            metricName => (inputs as any)[metricName] !== undefined
        );
        
        if (!hasAnyMetric) {
            errors.push('No metric values provided');
            return { isValid: false, errors, warnings };
        }
        
        // Validate each metric value
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            const value = (inputs as any)[metricName];
            
            if (value === undefined) {
                if (config.enabled) {
                    warnings.push(`Missing metric: ${metricName}`);
                }
                continue;
            }
            
            if (!isFinite(value)) {
                errors.push(`Metric ${metricName} value is not a finite number: ${value}`);
                continue;
            }
            
            if (value < 0 || value > 1) {
                errors.push(`Metric ${metricName} value ${value} is out of range [0,1]`);
            }
        }
        
        return {
            isValid: errors.length === 0,
            errors,
            warnings,
        };
    }
    
    /**
     * Get the current weighting scheme
     */
    getWeightingScheme(): WeightingScheme {
        return { ...this.scheme };
    }
    
    /**
     * Update the weighting scheme
     */
    setWeightingScheme(scheme: WeightingScheme): void {
        const errors = validateWeightingScheme(scheme);
        if (errors.length > 0) {
            throw new Error(`Invalid weighting scheme: ${errors.join(', ')}`);
        }
        
        this.scheme = scheme;
    }
    
    /**
     * Calculate score breakdown for analysis
     */
    calculateBreakdown(inputs: MetricInputs): MetricBreakdown[] {
        const breakdown: MetricBreakdown[] = [];
        let totalWeight = 0;
        
        // Calculate total weight for enabled metrics
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            if (config.enabled && (inputs as any)[metricName] !== undefined) {
                totalWeight += config.weight;
            }
        }
        
        // Calculate contribution for each metric
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            const value = (inputs as any)[metricName];
            
            if (value === undefined || !config.enabled) {
                continue;
            }
            
            const transformedValue = Math.pow(value, config.exponent);
            const contribution = config.weight * transformedValue;
            const normalizedContribution = totalWeight > 0 ? contribution / totalWeight : 0;
            
            breakdown.push({
                metric: metricName,
                value,
                weight: config.weight,
                exponent: config.exponent,
                transformedValue,
                contribution,
                normalizedContribution,
                percentageOfTotal: normalizedContribution * 100,
            });
        }
        
        return breakdown.sort((a, b) => b.contribution - a.contribution);
    }
    
    /**
     * Simulate score with different metric values
     */
    simulate(baseInputs: MetricInputs, variations: Partial<MetricInputs>): number {
        const combined = { ...baseInputs, ...variations };
        const result = this.computeScore(combined);
        return result.score;
    }
    
    /**
     * Batch calculate trust scores for multiple targets
     */
    async batchCalculate(request: BatchCalculationRequest): Promise<BatchCalculationResult> {
        const results: Array<{
            targetPubkey: string;
            score?: number;
            error?: string;
        }> = [];
        
        let successful = 0;
        let failed = 0;
        
        for (const targetPubkey of request.targetPubkeys) {
            try {
                // For batch calculation, we need to get the actual metric inputs
                // This is a simplified version - in practice, you'd fetch metrics for each target
                const score = await this.calculate(
                    {} as MetricInputs, // This would be populated with actual metrics
                    request.sourcePubkey,
                    targetPubkey,
                    request.options
                );
                
                results.push({
                    targetPubkey,
                    score: score.score,
                });
                
                successful++;
            } catch (error) {
                results.push({
                    targetPubkey,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
                
                failed++;
            }
        }
        
        return {
            sourcePubkey: request.sourcePubkey,
            results,
            totalProcessed: request.targetPubkeys.length,
            successful,
            failed,
            computedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Get cache statistics if caching is enabled
     */
    getCacheStats() {
        if (!this.cache) {
            return null;
        }
        
        return this.cache.getStats();
    }
    
    /**
     * Reset cache statistics if caching is enabled
     */
    resetCacheStats(): void {
        if (this.cache) {
            this.cache.resetStats();
        }
    }
    
    /**
     * Clean up expired cache entries if caching is enabled
     */
    async cleanupCache(): Promise<number> {
        if (!this.cache) {
            return 0;
        }
        
        return await this.cache.cleanup();
    }
    
    /**
     * Invalidate cache for a specific pubkey pair if caching is enabled
     */
    async invalidateCache(sourcePubkey: string, targetPubkey: string): Promise<void> {
        if (this.cache) {
            await this.cache.invalidate(sourcePubkey, targetPubkey);
        }
    }
    
    /**
     * Invalidate all cache entries for a pubkey if caching is enabled
     */
    async invalidateAllCache(pubkey: string): Promise<void> {
        if (this.cache) {
            await this.cache.invalidateAll(pubkey);
        }
    }
    
    /**
     * Check if a cached score exists if caching is enabled
     */
    async hasCachedScore(sourcePubkey: string, targetPubkey: string): Promise<boolean> {
        if (!this.cache) {
            return false;
        }
        
        return await this.cache.exists(sourcePubkey, targetPubkey);
    }
    
    /**
     * Get cached score without calculation if caching is enabled
     */
    async getCachedScore(sourcePubkey: string, targetPubkey: string): Promise<TrustScoreResult | null> {
        if (!this.cache) {
            return null;
        }
        
        return await this.cache.get(sourcePubkey, targetPubkey);
    }
    
    /**
     * Get all cached scores for a source pubkey if caching is enabled
     */
    async getCachedScoresForSource(sourcePubkey: string) {
        if (!this.cache) {
            return [];
        }
        
        return await this.cache.getScoresForSource(sourcePubkey);
    }
    
    /**
     * Get all cached scores for a target pubkey if caching is enabled
     */
    async getCachedScoresForTarget(targetPubkey: string) {
        if (!this.cache) {
            return [];
        }
        
        return await this.cache.getScoresForTarget(targetPubkey);
    }
}