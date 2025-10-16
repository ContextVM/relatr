/**
 * Type definitions for RelatrService
 */

/**
 * Request for calculating a single trust score
 */
export interface TrustScoreCalculationRequest {
    targetPubkey: string;
    sourcePubkey?: string;
    scheme?: string;
    forceRefresh?: boolean;
}

/**
 * Result of trust score calculation
 */
export interface TrustScoreCalculationResult {
    score: number;
    sourcePubkey: string;
    targetPubkey: string;
    scheme: string;
    metrics: {
        distance: number;
        distanceWeight: number;
        nip05Valid: number;
        lightningAddress: number;
        eventKind10002: number;
        reciprocity: number;
    };
    computedAt: number;
    cached: boolean;
    duration: number;
    breakdown?: {
        distanceQuery: number;
        metricsCollection: number;
        scoreCalculation: number;
    };
}

/**
 * Request for calculating batch trust scores
 */
export interface BatchTrustScoreRequest {
    targetPubkeys: string[];
    sourcePubkey?: string;
    scheme?: string;
    forceRefresh?: boolean;
}

/**
 * Result of batch trust score calculation
 */
export interface BatchTrustScoreResult {
    sourcePubkey: string;
    results: TrustScoreCalculationResult[];
    summary: {
        total: number;
        successful: number;
        failed: number;
        duration: number;
        averageDuration: number;
    };
    errors?: Array<{
        pubkey: string;
        error: string;
    }>;
}

/**
 * Service health status
 */
export interface ServiceHealthStatus {
    healthy: boolean;
    initialized: boolean;
    uptime: number;
    components: Record<string, {
        healthy: boolean;
        details?: string;
        error?: string;
    }>;
    stats: ServiceStats;
    error?: string;
}

/**
 * Service statistics
 */
export interface ServiceStats {
    initialized: boolean;
    uptime: number;
    operationCount: number;
    errorCount: number;
    errorRate: number;
    lastHealthCheck?: number;
    graphStats?: {
        users: number;
        edges: number;
        rootPubkey: string;
    };
    metricsCacheStats?: {
        hits: number;
        misses: number;
        total: number;
        hitRate: number;
        lastReset: number;
    };
    trustCacheStats?: {
        hits: number;
        misses: number;
        hitRate: number;
        totalEntries: number;
        expiredEntries: number;
        lastCleanup: number;
    };
    databaseStats?: {
        uniquePubkeys: number;
        totalMetrics: number;
        lastComputation: number;
    };
}

/**
 * Configuration for RelatrService
 */
export interface RelatrServiceConfig {
    defaultSourcePubkey?: string;
    enableMetrics?: boolean;
    enableLogging?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    performanceMonitoring?: boolean;
}

/**
 * Performance metrics for operations
 */
export interface PerformanceMetrics {
    operation: string;
    duration: number;
    timestamp: number;
    success: boolean;
    metadata?: Record<string, any>;
}

/**
 * Service initialization options
 */
export interface ServiceInitializationOptions {
    skipHealthCheck?: boolean;
    skipCacheWarmup?: boolean;
    forceReinit?: boolean;
}

/**
 * Cache management options
 */
export interface CacheManagementOptions {
    cleanupExpired?: boolean;
    resetStats?: boolean;
    invalidateAll?: boolean;
}

/**
 * Error types for service operations
 */
export class RelatrServiceError extends Error {
    constructor(
        message: string,
        public code: string,
        public component?: string,
        public pubkey?: string
    ) {
        super(message);
        this.name = 'RelatrServiceError';
    }
}

/**
 * Service error codes
 */
export const RelatrServiceErrorCodes = {
    NOT_INITIALIZED: 'SERVICE_NOT_INITIALIZED',
    INITIALIZATION_FAILED: 'INITIALIZATION_FAILED',
    COMPONENT_ERROR: 'COMPONENT_ERROR',
    CALCULATION_FAILED: 'CALCULATION_FAILED',
    CACHE_ERROR: 'CACHE_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR',
} as const;

export type RelatrServiceErrorCode = typeof RelatrServiceErrorCodes[keyof typeof RelatrServiceErrorCodes];

/**
 * Operation context for tracking and debugging
 */
export interface OperationContext {
    operationId: string;
    operation: string;
    startTime: number;
    sourcePubkey?: string;
    targetPubkey?: string;
    metadata?: Record<string, any>;
}

/**
 * Service event types
 */
export type ServiceEvent = 
    | { type: 'operation_started'; context: OperationContext }
    | { type: 'operation_completed'; context: OperationContext; duration: number; result: any }
    | { type: 'operation_failed'; context: OperationContext; duration: number; error: string }
    | { type: 'cache_hit'; pubkey: string; cacheType: string }
    | { type: 'cache_miss'; pubkey: string; cacheType: string }
    | { type: 'component_error'; component: string; error: string };

/**
 * Event listener for service events
 */
export type ServiceEventListener = (event: ServiceEvent) => void;

/**
 * Service monitoring configuration
 */
export interface MonitoringConfig {
    enableEvents?: boolean;
    enableMetrics?: boolean;
    enableTracing?: boolean;
    samplingRate?: number;
    maxEvents?: number;
    maxMetrics?: number;
}