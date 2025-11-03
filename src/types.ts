import type { NostrEvent } from "nostr-tools";

/**
 * Core type definitions for Relatr v2
 */

// Configuration types
export interface RelatrConfig {
  defaultSourcePubkey: string;
  graphBinaryPath: string;
  databasePath: string;
  nostrRelays: string[];
  serverSecretKey: string;
  serverRelays: string[];
  decayFactor: number;
  cacheTtlSeconds: number;
  numberOfHops: number;
  syncInterval: number;
  cleanupInterval: number;
}
export interface MetricWeights {
  distanceWeight: number;
  validators: Record<string, number>; // Dynamic validator weights
}

// Data types
export interface ProfileMetrics {
  pubkey: string;
  metrics: Record<string, number>; // Flexible metric storage
  computedAt: number;
}

export interface TrustScore {
  sourcePubkey: string;
  targetPubkey: string;
  score: number;
  components: ScoreComponents;
  computedAt: number;
}

export interface ScoreComponents {
  distanceWeight: number;
  validators: Record<string, number>;
  socialDistance: number;
  normalizedDistance: number;
}

export interface NormalizedProfileMetricRow {
  id: number;
  pubkey: string;
  metric_key: string;
  metric_value: number;
  computed_at: number;
  expires_at: number;
}

export interface ProfileMetricEntry {
  pubkey: string;
  metric_key: string;
  metric_value: number;
  computed_at: number;
  expires_at: number;
}

// MCP types
export interface CalculateTrustScoreParams {
  sourcePubkey?: string;
  targetPubkey: string;
  weightingScheme?: "default" | "social" | "validation" | "strict";
}

export interface CalculateTrustScoreResult {
  trustScore: TrustScore;
  computationTimeMs: number;
}

export interface StatsResult {
  timestamp: number;
  sourcePubkey: string;
  database: {
    metrics: {
      totalEntries: number;
    };
    metadata: {
      totalEntries: number;
    };
  };
  socialGraph: {
    stats: {
      users: number;
      follows: number;
      mutes: number;
    };
    rootPubkey: string;
  };
}

export interface ManageCacheResult {
  success: boolean;
  metricsCleared?: number;
  message: string;
}

export interface FetchNostrEventsParams {
  sourcePubkey?: string;
  hops?: number;
  kind: 0 | 3;
}

export interface FetchNostrEventsResult {
  success: boolean;
  eventsFetched: number;
  message: string;
  pubkeys?: string[];
  events?: NostrEvent[];
}

export interface CreateSocialGraphResult {
  success: boolean;
  message: string;
  eventsFetched: number;
  graphSize: {
    users: number;
    follows: number;
  };
}

// Search types
export interface SearchProfilesParams {
  query: string;
  limit?: number;
  sourcePubkey?: string;
  extendToNostr: boolean;
  weightingScheme?: WeightingScheme;
}

export interface SearchProfileResult {
  pubkey: string;
  profile: NostrProfile;
  trustScore: number;
  rank: number;
  exactMatch?: boolean;
}

export interface SearchProfilesResult {
  results: SearchProfileResult[];
  totalFound: number;
  searchTimeMs: number;
}

// Nostr types
export interface NostrProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  lud16?: string;
  about?: string;
}

// Social graph types
export interface SocialGraphNode {
  pubkey: string;
  follows: string[];
  followers: string[];
}

export interface SocialGraphStats {
  totalNodes: number;
  totalEdges: number;
  averageDegree: number;
  maxDistance: number;
}

// Validation types
export interface ValidationResult {
  valid: boolean;
  score: number;
  reason?: string;
  details?: Record<string, any>;
}

export interface ValidationMetrics {
  nip05: ValidationResult;
  lightning: ValidationResult;
  event: ValidationResult;
  reciprocity: ValidationResult;
}

// Cache types
export interface CacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
  createdAt: number;
}

export interface CacheStats {
  totalEntries: number;
  expiredEntries: number;
  hitRate: number;
  lastCleanup: number;
}

// Error types
export class RelatrError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "RelatrError";
  }
}

export class DatabaseError extends RelatrError {
  constructor(
    message: string,
    public sql?: string,
  ) {
    super(message, "DATABASE_ERROR");
    this.name = "DatabaseError";
  }
}

export class ValidationError extends RelatrError {
  constructor(
    message: string,
    public field?: string,
  ) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class DataStoreError extends RelatrError {
  constructor(
    message: string,
    public operation?: string,
  ) {
    super(message, "CACHE_ERROR");
    this.name = "DataStoreError";
  }
}

export class SocialGraphError extends RelatrError {
  constructor(
    message: string,
    public operation?: string,
  ) {
    super(message, "SOCIAL_GRAPH_ERROR");
    this.name = "SocialGraphError";
  }
}

// Utility types
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

// Database connection type
export interface DatabaseConnection {
  close(): void;
  prepare(sql: string): any;
  exec(sql: string): any;
  query(sql: string): any;
}

// Cache key types
export type DataStoreKey = string | [string, string];

// Weighting scheme type
export type WeightingScheme = "default" | "social" | "validation" | "strict";

// Health check component type
export type HealthComponent = "database" | "socialGraph";

// Cache management action type
export type CacheAction = "clear" | "cleanup" | "stats";
