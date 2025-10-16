/**
 * All metric inputs for trust score calculation
 */
export interface MetricInputs {
    distanceWeight: number;       // From DistanceNormalizer
    nip05Valid: number;           // From ProfileMetricsCollector
    lightningAddress: number;     // From ProfileMetricsCollector
    eventKind10002: number;       // From ProfileMetricsCollector
    reciprocity: number;          // From ProfileMetricsCollector
}

/**
 * Configuration for a single metric
 */
export interface MetricConfig {
    weight: number;      // w_i in the formula
    exponent: number;    // p_i in the formula (default 1.0)
    enabled: boolean;    // Whether to include this metric
}

/**
 * Weighting scheme configuration
 */
export interface WeightingScheme {
    name: string;
    version: string;
    metrics: Record<string, MetricConfig>;
}

/**
 * Trust score calculation result
 */
export interface TrustScoreResult {
    score: number;                          // Final trust score [0,1]
    metricValues: Record<string, number>;   // Input metric values used
    metricWeights: Record<string, number>;  // Weights used
    computedAt: number;                     // Unix timestamp
}

/**
 * Detailed breakdown of score calculation
 */
export interface MetricBreakdown {
    metric: string;
    value: number;
    weight: number;
    exponent: number;
    transformedValue: number;
    contribution: number;
    normalizedContribution: number;
    percentageOfTotal: number;
}

/**
 * Trust score calculation configuration
 */
export interface TrustScoreConfig {
    weightingScheme?: WeightingScheme;
    cacheResults?: boolean;
    cacheTtlSeconds?: number;
}

/**
 * Cache entry metadata
 */
export interface CacheEntry {
    sourcePubkey: string;
    targetPubkey: string;
    result: TrustScoreResult;
    expiresAt: number;
}

/**
 * Score visualization data
 */
export interface ScoreVisualization {
    score: number;
    breakdown: MetricBreakdown[];
    chartData: {
        labels: string[];
        values: number[];
        colors: string[];
    };
}

/**
 * Trust score calculation options
 */
export interface CalculationOptions {
    forceRefresh?: boolean;
    includeBreakdown?: boolean;
    validateInputs?: boolean;
}

/**
 * Metric validation result
 */
export interface MetricValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Trust score statistics
 */
export interface TrustScoreStats {
    totalScores: number;
    averageScore: number;
    minScore: number;
    maxScore: number;
    scoreDistribution: Record<string, number>;
    lastUpdated: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
    hits: number;
    misses: number;
    hitRate: number;
    totalEntries: number;
    expiredEntries: number;
    lastCleanup: number;
}

/**
 * Weighting scheme metadata
 */
export interface WeightingSchemeMetadata {
    name: string;
    version: string;
    description: string;
    author?: string;
    createdAt: number;
    tags: string[];
    isDefault: boolean;
}

/**
 * Trust score calculation error
 */
export interface TrustScoreError extends Error {
    code: string;
    metric?: string;
    value?: number;
}

/**
 * Batch calculation request
 */
export interface BatchCalculationRequest {
    sourcePubkey: string;
    targetPubkeys: string[];
    options?: CalculationOptions;
}

/**
 * Batch calculation result
 */
export interface BatchCalculationResult {
    sourcePubkey: string;
    results: Array<{
        targetPubkey: string;
        score?: number;
        error?: string;
    }>;
    totalProcessed: number;
    successful: number;
    failed: number;
    computedAt: number;
}