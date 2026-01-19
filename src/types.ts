import type { PublishResponse } from "applesauce-relay";

export type { NostrEvent } from "nostr-tools";

/**
 * Core type definitions for Relatr v2
 */

// Configuration types
export interface RelatrConfig {
  defaultSourcePubkey: string;
  databasePath: string;
  nostrRelays: string[];
  serverSecretKey: string;
  serverRelays: string[];
  taExtraRelays: string[];
  decayFactor: number;
  cacheTtlHours: number;
  numberOfHops: number;
  syncIntervalHours: number;
  cleanupIntervalHours: number;
  validationSyncIntervalHours: number;

  /**
   * Optional feature flag: enable Trusted Assertions
   * (NIP-85 kind 30382) publishing. Controlled by the operator.
   */
  taEnabled: boolean;

  /**
   * Elo plugins configuration
   */
  eloPluginsEnabled: boolean;
  eloPluginsDir: string;
  eloPluginTimeoutMs: number;
  capTimeoutMs: number;

  /**
   * MCP server configuration
   */
  isPublicServer: boolean;
  serverName?: string;
  serverAbout?: string;
  serverWebsite?: string;
  serverPicture?: string;
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
  expiresAt: number;
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
  validators: Record<string, { score: number; description?: string }>;
  socialDistance: number;
  normalizedDistance: number;
}

// MCP types
export interface CalculateTrustScoreParams {
  sourcePubkey?: string;
  targetPubkey: string;
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
    };
    rootPubkey: string;
  };
}

// Search types
export interface SearchProfilesParams {
  query: string;
  limit?: number;
  sourcePubkey?: string;
  extendToNostr?: boolean;
}

export interface SearchProfileResult {
  pubkey: string;
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

// Validation types
export interface ValidationResult {
  valid: boolean;
  score: number;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ValidationMetrics {
  nip05: ValidationResult;
  lightning: ValidationResult;
  event: ValidationResult;
  reciprocity: ValidationResult;
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

export class SocialGraphError extends RelatrError {
  constructor(
    message: string,
    public operation?: string,
  ) {
    super(message, "SOCIAL_GRAPH_ERROR");
    this.name = "SocialGraphError";
  }
}

// TA-related types
export interface TA {
  id: number;
  pubkey: string;
  latestRank: number | null;
  createdAt: number;
  computedAt: number;
  isActive: boolean;
}

export interface TARankUpdateResult {
  published: boolean;
  rank: number;
  previousRank: number | null;
  relayResults?: PublishResponse[];
}
