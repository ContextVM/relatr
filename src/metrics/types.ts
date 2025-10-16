/**
 * Profile validation metrics types for Relatr
 * All metrics are normalized to binary values (0.0 or 1.0)
 */

/**
 * All profile metrics for a pubkey
 */
export interface ProfileMetrics {
    pubkey: string;
    nip05Valid: number;        // 0.0 or 1.0
    lightningAddress: number;  // 0.0 or 1.0
    eventKind10002: number;    // 0.0 or 1.0
    reciprocity: number;       // 0.0 or 1.0
    computedAt: number;        // Unix timestamp
}

/**
 * Single metric value with metadata
 */
export interface MetricValue {
    name: string;
    value: number;
    computedAt: number;
    expiresAt?: number;
}

/**
 * Metric computation result with error handling
 */
export interface MetricResult {
    success: boolean;
    value: number;
    error?: string;
    metadata?: Record<string, any>;
}

/**
 * NIP-05 validation result
 */
export interface Nip05Result {
    valid: boolean;
    nip05: string;
    pubkey: string;
    domain?: string;
    error?: string;
    verifiedAt: number;
}

/**
 * Lightning address validation result
 */
export interface LightningResult {
    hasAddress: boolean;
    address?: string;
    type?: 'lud16' | 'lud06';
    validFormat: boolean;
    error?: string;
    verifiedAt: number;
}

/**
 * Profile metadata structure from Nostr kind 0 events
 */
export interface NostrProfile {
    name?: string;
    display_name?: string;
    about?: string;
    picture?: string;
    nip05?: string;
    lud06?: string;  // LNURL
    lud16?: string;  // Lightning Address (user@domain.com)
    [key: string]: any;
}

/**
 * Event validation result
 */
export interface EventResult {
    hasEvent: boolean;
    eventKind: number;
    eventId?: string;
    eventContent?: string;
    eventCreatedAt?: number;
    error?: string;
    verifiedAt: number;
}

/**
 * Reciprocity validation result
 */
export interface ReciprocityResult {
    isReciprocal: boolean;
    sourceFollowsTarget: boolean;
    targetFollowsSource: boolean;
    sourceInGraph: boolean;
    targetInGraph: boolean;
    error?: string;
    verifiedAt: number;
}

/**
 * Complete profile metrics collection result
 */
export interface ProfileMetricsCollectionResult {
    pubkey: string;
    sourcePubkey?: string;
    metrics: ProfileMetrics;
    details?: {
        nip05?: Nip05Result;
        lightning?: LightningResult;
        event?: EventResult;
        reciprocity?: ReciprocityResult;
    };
    collectedAt: number;
    cacheHit: boolean;
    errors?: string[];
}

/**
 * Metric collection configuration options
 */
export interface MetricCollectionOptions {
    forceRefresh?: boolean;        // Bypass cache
    timeout?: number;             // Request timeout in ms
    retries?: number;             // Number of retry attempts
    parallel?: boolean;           // Execute validators in parallel
    includeDetails?: boolean;     // Include detailed validation results
}

/**
 * Batch metric collection request
 */
export interface BatchMetricCollectionRequest {
    targetPubkeys: string[];
    sourcePubkey?: string;
    options?: MetricCollectionOptions;
}

/**
 * Batch metric collection result
 */
export interface BatchMetricCollectionResult {
    results: ProfileMetricsCollectionResult[];
    summary: {
        total: number;
        successful: number;
        failed: number;
        cacheHits: number;
        duration: number; // in milliseconds
    };
    errors: Array<{
        pubkey: string;
        error: string;
    }>;
}

/**
 * Cache entry for profile metrics
 */
export interface MetricsCacheEntry {
    pubkey: string;
    metrics: ProfileMetrics;
    expiresAt: number;
    cachedAt: number;
}

/**
 * TTL configuration for different metric types
 */
export interface CacheTtlConfig {
    nip05: number;      // TTL in seconds for NIP-05 validation
    lightning: number;  // TTL in seconds for Lightning validation
    events: number;     // TTL in seconds for event validation
    reciprocity: number; // TTL in seconds for reciprocity checks
    default: number;    // Default TTL for all metrics
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
    hits: number;
    misses: number;
    total: number;
    hitRate: number;
    lastReset: number;
}

/**
 * Validator configuration options
 */
export interface ValidatorConfig {
    timeout: number;           // Request timeout in milliseconds
    retries: number;           // Number of retry attempts
    retryDelay: number;        // Delay between retries in milliseconds
    enableLogging: boolean;    // Enable detailed logging
}

/**
 * NIP-05 validator specific configuration
 */
export interface Nip05ValidatorConfig extends ValidatorConfig {
    wellKnownTimeout: number;  // Timeout for .well-known lookup
    verifySignature: boolean;  // Verify NIP-05 signature
}

/**
 * Lightning validator specific configuration
 */
export interface LightningValidatorConfig extends ValidatorConfig {
    validateLnurl: boolean;    // Perform LNURL validation
    checkConnectivity: boolean; // Test Lightning address connectivity
}

/**
 * Metrics cache configuration
 */
export interface MetricsCacheConfig {
    defaultTtl: number;        // Default TTL in seconds
    maxEntries: number;        // Maximum cache entries
    cleanupInterval: number;   // Cleanup interval in milliseconds
    enableStats: boolean;      // Enable cache statistics
}

/**
 * Profile metrics collector configuration
 */
export interface ProfileMetricsConfig {
    relays: string[];
    cacheTtlSeconds: number;
    enableNip05: boolean;
    enableLightning: boolean;
    enableEventKind10002: boolean;
    enableReciprocity: boolean;
    validatorConfig: {
        nip05: Nip05ValidatorConfig;
        lightning: LightningValidatorConfig;
    };
    cacheConfig: MetricsCacheConfig;
}

/**
 * Error types for metrics validation
 */
export class MetricsError extends Error {
    constructor(
        message: string,
        public code: string,
        public metric?: string,
        public pubkey?: string
    ) {
        super(message);
        this.name = 'MetricsError';
    }
}

/**
 * Metrics error codes
 */
export const MetricsErrorCodes = {
    RELAY_UNAVAILABLE: 'RELAY_UNAVAILABLE',
    INVALID_PROFILE: 'INVALID_PROFILE',
    NIP05_VERIFICATION_FAILED: 'NIP05_VERIFICATION_FAILED',
    NIP05_DOMAIN_ERROR: 'NIP05_DOMAIN_ERROR',
    NIP05_TIMEOUT: 'NIP05_TIMEOUT',
    LIGHTNING_FORMAT_ERROR: 'LIGHTNING_FORMAT_ERROR',
    LIGHTNING_VALIDATION_FAILED: 'LIGHTNING_VALIDATION_FAILED',
    CACHE_ERROR: 'CACHE_ERROR',
    CACHE_EXPIRED: 'CACHE_EXPIRED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

/**
 * Metric type definitions
 */
export const METRIC_TYPES = {
    NIP05_VALID: 'nip05_valid',
    LIGHTNING_ADDRESS: 'lightning_address',
    EVENT_KIND_10002: 'event_kind_10002',
    RECIPROCITY: 'reciprocity',
} as const;

export type MetricType = typeof METRIC_TYPES[keyof typeof METRIC_TYPES];