import type { 
    DistanceNormalizerConfig, 
    NormalizationResult, 
    BatchNormalizationResult,
    DecayCurvePoint 
} from './types';
import { validateDecayProfile } from './DecayProfiles';

/**
 * Normalizes social graph distances to floating-point weights
 */
export class DistanceNormalizer {
    private config: DistanceNormalizerConfig;
    
    constructor(config?: Partial<DistanceNormalizerConfig>) {
        // Set defaults
        this.config = {
            decayFactor: config?.decayFactor ?? 0.1,
            maxDistance: config?.maxDistance ?? 1000,
            selfWeight: config?.selfWeight ?? 1.0,
        };
        
        // Validate configuration
        this.validateConfig();
    }
    
    /**
     * Normalize a single distance to a weight
     * 
     * @param distance - Integer hop count from social graph
     * @returns Normalized weight in [0, 1]
     */
    normalize(distance: number): number {
        // Validate input
        if (!Number.isInteger(distance) || distance < 0) {
            throw new Error(`Invalid distance: ${distance}. Must be non-negative integer.`);
        }
        
        // Special case: distance to self
        if (distance === 0) {
            return this.config.selfWeight;
        }
        
        // Special case: distance 1 (direct follow) always returns 1.0
        if (distance === 1) {
            return 1.0;
        }
        
        // Unreachable (distance >= maxDistance)
        if (distance >= this.config.maxDistance) {
            return 0.0;
        }
        
        // Apply linear decay formula: Distance Score = max(0, 1 - α × (distance - 1))
        const weight = 1.0 - this.config.decayFactor * (distance - 1);
        
        // Clamp to [0, 1]
        return Math.max(0.0, Math.min(1.0, weight));
    }
    
    /**
     * Normalize a distance with full result information
     * 
     * @param distance - Integer hop count from social graph
     * @returns Complete normalization result
     */
    normalizeWithResult(distance: number): NormalizationResult {
        const weight = this.normalize(distance);
        const isReachable = this.isReachable(distance);
        
        return {
            distance,
            weight,
            isReachable,
        };
    }
    
    /**
     * Normalize multiple distances at once
     * 
     * @param distances - Map of pubkey to distance
     * @returns Map of pubkey to weight
     */
    normalizeMany(distances: Map<string, number>): Map<string, number> {
        const weights = new Map<string, number>();
        
        for (const [pubkey, distance] of distances) {
            weights.set(pubkey, this.normalize(distance));
        }
        
        return weights;
    }
    
    /**
     * Normalize multiple distances with full result information
     * 
     * @param distances - Map of pubkey to distance
     * @returns Array of batch normalization results
     */
    normalizeManyWithResult(distances: Map<string, number>): BatchNormalizationResult[] {
        const results: BatchNormalizationResult[] = [];
        
        for (const [pubkey, distance] of distances) {
            const result = this.normalizeWithResult(distance);
            results.push({
                pubkey,
                ...result,
            });
        }
        
        return results;
    }
    
    /**
     * Get the distance threshold where weight becomes zero
     * 
     * @returns Distance at which weight = 0
     */
    getZeroWeightThreshold(): number {
        // Solve: 0 = 1 - α(d - 1)
        // α(d - 1) = 1
        // d - 1 = 1/α
        // d = 1 + 1/α
        
        const threshold = 1 + (1 / this.config.decayFactor);
        return Math.ceil(threshold);
    }
    
    /**
     * Get weight at a specific distance without normalization
     * Useful for understanding the decay curve
     */
    getRawWeight(distance: number): number {
        if (distance === 0) return this.config.selfWeight;
        if (distance >= this.config.maxDistance) return 0.0;
        
        return 1.0 - this.config.decayFactor * (distance - 1);
    }
    
    /**
     * Check if a distance is considered "reachable"
     */
    isReachable(distance: number): boolean {
        return distance < this.config.maxDistance && distance >= 0 && Number.isInteger(distance);
    }
    
    /**
     * Get current configuration
     */
    getConfig(): DistanceNormalizerConfig {
        return { ...this.config };
    }
    
    /**
     * Update configuration
     */
    updateConfig(updates: Partial<DistanceNormalizerConfig>): void {
        this.config = {
            ...this.config,
            ...updates,
        };
        this.validateConfig();
    }
    
    /**
     * Validate configuration parameters
     */
    private validateConfig(): void {
        const errors = validateDecayProfile(this.config);
        
        if (errors.length > 0) {
            throw new Error(`Invalid DistanceNormalizer configuration:\n${errors.join('\n')}`);
        }
    }
    
    /**
     * Generate a decay curve for visualization
     * 
     * @param maxDist - Maximum distance to generate
     * @returns Array of [distance, weight] pairs
     */
    generateDecayCurve(maxDist: number = 20): Array<[number, number]> {
        const curve: Array<[number, number]> = [];
        
        for (let d = 0; d <= maxDist; d++) {
            curve.push([d, this.normalize(d)]);
        }
        
        return curve;
    }
    
    /**
     * Generate a decay curve with detailed points
     * 
     * @param maxDist - Maximum distance to generate
     * @returns Array of decay curve points
     */
    generateDetailedDecayCurve(maxDist: number = 20): DecayCurvePoint[] {
        const curve: DecayCurvePoint[] = [];
        
        for (let d = 0; d <= maxDist; d++) {
            curve.push({
                distance: d,
                weight: this.normalize(d),
            });
        }
        
        return curve;
    }
    
    /**
     * Get summary statistics for the current configuration
     */
    getStatistics(): {
        zeroWeightThreshold: number;
        effectiveReach: number;
        halfWeightDistance: number;
        quarterWeightDistance: number;
    } {
        const zeroWeightThreshold = this.getZeroWeightThreshold();
        
        // Calculate distance where weight drops to 0.5
        // 0.5 = 1 - α(d - 1)
        // α(d - 1) = 0.5
        // d - 1 = 0.5/α
        // d = 1 + 0.5/α
        const halfWeightDistance = Math.ceil(1 + (0.5 / this.config.decayFactor));
        
        // Calculate distance where weight drops to 0.25
        // 0.25 = 1 - α(d - 1)
        // α(d - 1) = 0.75
        // d - 1 = 0.75/α
        // d = 1 + 0.75/α
        const quarterWeightDistance = Math.ceil(1 + (0.75 / this.config.decayFactor));
        
        return {
            zeroWeightThreshold,
            effectiveReach: Math.min(zeroWeightThreshold, this.config.maxDistance),
            halfWeightDistance,
            quarterWeightDistance,
        };
    }
    
    /**
     * Compare two distances and return their normalized weights
     */
    compare(dist1: number, dist2: number): {
        distance1: number;
        distance2: number;
        weight1: number;
        weight2: number;
        difference: number;
        ratio: number;
    } {
        const weight1 = this.normalize(dist1);
        const weight2 = this.normalize(dist2);
        
        return {
            distance1: dist1,
            distance2: dist2,
            weight1,
            weight2,
            difference: weight1 - weight2,
            ratio: weight2 > 0 ? weight1 / weight2 : Infinity,
        };
    }
}