import type { RelatrConfig, TrustScore, ProfileMetrics, MetricWeights, ScoreComponents } from '../types';
import { SocialGraphError } from '../types';
import { SimpleCache } from '../database/cache';

/**
 * Trust score calculation using distance normalization and weighted metrics
 * Implements the formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
 */
export class TrustCalculator {
    private config: RelatrConfig;
    private cache: SimpleCache<TrustScore>;

    /**
     * Create a new TrustCalculator instance
     * @param config - Relatr configuration
     * @param cache - Cache instance for storing trust scores
     */
    constructor(config: RelatrConfig, cache: SimpleCache<TrustScore>) {
        if (!config) {
            throw new SocialGraphError('Config is required', 'CONSTRUCTOR');
        }
        if (!cache) {
            throw new SocialGraphError('Cache is required', 'CONSTRUCTOR');
        }

        this.config = config;
        this.cache = cache;
    }

    /**
     * Calculate trust score between source and target pubkeys
     * @param sourcePubkey - Source public key
     * @param targetPubkey - Target public key
     * @param metrics - Profile metrics for target pubkey
     * @param distance - Social distance between source and target
     * @param weights - Optional custom weights (overrides config weights)
     * @returns Complete trust score with all components
     * @throws SocialGraphError if calculation fails
     */
    async calculate(
        sourcePubkey: string,
        targetPubkey: string,
        metrics: ProfileMetrics,
        distance: number,
        weights?: Partial<MetricWeights>
    ): Promise<TrustScore> {
        // Validate inputs
        if (!sourcePubkey || typeof sourcePubkey !== 'string') {
            throw new SocialGraphError('Source pubkey must be a non-empty string', 'CALCULATE');
        }
        if (!targetPubkey || typeof targetPubkey !== 'string') {
            throw new SocialGraphError('Target pubkey must be a non-empty string', 'CALCULATE');
        }
        if (!metrics) {
            throw new SocialGraphError('Metrics are required', 'CALCULATE');
        }
        if (typeof distance !== 'number' || distance < 0) {
            throw new SocialGraphError('Distance must be a non-negative number', 'CALCULATE');
        }

        // Check cache first
        const cacheKey: [string, string] = [sourcePubkey, targetPubkey];
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        // Merge weights
        const finalWeights = this.mergeWeights(this.config.weights, weights);

        // Normalize distance
        const normalizedDistance = this.normalizeDistance(distance);

        // Calculate weighted score
        const score = this.calculateWeightedScore(
            metrics,
            normalizedDistance,
            finalWeights
        );

        // Create score components
        const components: ScoreComponents = {
            distanceWeight: finalWeights.distanceWeight,
            nip05Valid: finalWeights.nip05Valid,
            lightningAddress: finalWeights.lightningAddress,
            eventKind10002: finalWeights.eventKind10002,
            reciprocity: finalWeights.reciprocity,
            socialDistance: distance,
            normalizedDistance
        };

        // Create trust score object
        const trustScore: TrustScore = {
            sourcePubkey,
            targetPubkey,
            score,
            components,
            computedAt: Math.floor(Date.now() / 1000)
        };

        // Cache the result
        await this.cache.set(cacheKey, trustScore);

        return trustScore;
    }

    /**
     * Normalize distance using exponential decay formula: e^(-α × distance)
     * @param distance - Social distance in hops
     * @returns Normalized distance value [0,1]
     */
    normalizeDistance(distance: number): number {
        if (typeof distance !== 'number' || distance < 0 || isNaN(distance) || !isFinite(distance)) {
            throw new SocialGraphError('Distance must be a non-negative finite number', 'NORMALIZE_DISTANCE');
        }

        // Special case: distance = 1000 → normalized = 0.0 (unreachable)
        if (distance === 1000) {
            return 0.0;
        }

        // Apply exponential decay: e^(-α × distance)
        const decayFactor = this.config.decayFactor;
        const normalized = Math.exp(-decayFactor * distance);

        // Ensure result is in [0,1] range
        return Math.max(0.0, Math.min(1.0, normalized));
    }

    /**
     * Calculate weighted score using the formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
     * @param metrics - Profile metrics
     * @param normalizedDistance - Normalized distance value
     * @param weights - Metric weights
     * @returns Final trust score [0,1]
     * @private
     */
    private calculateWeightedScore(
        metrics: ProfileMetrics,
        normalizedDistance: number,
        weights: MetricWeights
    ): number {
        // Calculate weighted sum
        const weightedSum = 
            weights.distanceWeight * normalizedDistance +
            weights.nip05Valid * metrics.nip05Valid +
            weights.lightningAddress * metrics.lightningAddress +
            weights.eventKind10002 * metrics.eventKind10002 +
            weights.reciprocity * metrics.reciprocity;

        // Calculate total weight
        const totalWeight = 
            weights.distanceWeight +
            weights.nip05Valid +
            weights.lightningAddress +
            weights.eventKind10002 +
            weights.reciprocity;

        // Avoid division by zero
        if (totalWeight === 0) {
            return 0.0;
        }

        // Calculate final score
        const score = weightedSum / totalWeight;

        // Ensure result is in [0,1] range
        return Math.max(0.0, Math.min(1.0, score));
    }

    /**
     * Merge default weights with custom weights
     * @param defaults - Default weights from config
     * @param custom - Optional custom weights to override defaults
     * @returns Merged weights
     * @private
     */
    private mergeWeights(
        defaults: MetricWeights,
        custom?: Partial<MetricWeights>
    ): MetricWeights {
        if (!custom) {
            return defaults;
        }

        return {
            distanceWeight: custom.distanceWeight ?? defaults.distanceWeight,
            nip05Valid: custom.nip05Valid ?? defaults.nip05Valid,
            lightningAddress: custom.lightningAddress ?? defaults.lightningAddress,
            eventKind10002: custom.eventKind10002 ?? defaults.eventKind10002,
            reciprocity: custom.reciprocity ?? defaults.reciprocity
        };
    }

    /**
     * Get the current configuration
     * @returns Current RelatrConfig
     */
    getConfig(): RelatrConfig {
        return { ...this.config };
    }

    /**
     * Update the configuration
     * @param newConfig - New configuration to use
     */
    updateConfig(newConfig: Partial<RelatrConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Calculate trust score without caching
     * @param sourcePubkey - Source public key
     * @param targetPubkey - Target public key
     * @param metrics - Profile metrics for target pubkey
     * @param distance - Social distance between source and target
     * @param weights - Optional custom weights
     * @returns Trust score without caching
     */
    calculateWithoutCache(
        sourcePubkey: string,
        targetPubkey: string,
        metrics: ProfileMetrics,
        distance: number,
        weights?: Partial<MetricWeights>
    ): TrustScore {
        // Validate inputs
        if (!sourcePubkey || typeof sourcePubkey !== 'string') {
            throw new SocialGraphError('Source pubkey must be a non-empty string', 'CALCULATE_WITHOUT_CACHE');
        }
        if (!targetPubkey || typeof targetPubkey !== 'string') {
            throw new SocialGraphError('Target pubkey must be a non-empty string', 'CALCULATE_WITHOUT_CACHE');
        }
        if (!metrics) {
            throw new SocialGraphError('Metrics are required', 'CALCULATE_WITHOUT_CACHE');
        }
        if (typeof distance !== 'number' || distance < 0) {
            throw new SocialGraphError('Distance must be a non-negative number', 'CALCULATE_WITHOUT_CACHE');
        }

        // Merge weights
        const finalWeights = this.mergeWeights(this.config.weights, weights);

        // Normalize distance
        const normalizedDistance = this.normalizeDistance(distance);

        // Calculate weighted score
        const score = this.calculateWeightedScore(
            metrics,
            normalizedDistance,
            finalWeights
        );

        // Create score components
        const components: ScoreComponents = {
            distanceWeight: finalWeights.distanceWeight,
            nip05Valid: finalWeights.nip05Valid,
            lightningAddress: finalWeights.lightningAddress,
            eventKind10002: finalWeights.eventKind10002,
            reciprocity: finalWeights.reciprocity,
            socialDistance: distance,
            normalizedDistance
        };

        // Create trust score object
        return {
            sourcePubkey,
            targetPubkey,
            score,
            components,
            computedAt: Math.floor(Date.now() / 1000)
        };
    }

    /**
     * Clear cache for a specific pubkey pair
     * @param sourcePubkey - Source public key
     * @param targetPubkey - Target public key
     */
    async clearCache(sourcePubkey: string, targetPubkey: string): Promise<void> {
        const cacheKey: [string, string] = [sourcePubkey, targetPubkey];
        await this.cache.clear(cacheKey);
    }

    /**
     * Clear all trust score cache
     */
    async clearAllCache(): Promise<void> {
        await this.cache.clear();
    }

    /**
     * Clean up expired cache entries
     * @returns Number of entries cleaned up
     */
    async cleanupCache(): Promise<number> {
        return await this.cache.cleanup();
    }
}