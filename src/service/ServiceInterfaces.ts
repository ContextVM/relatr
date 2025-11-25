/**
 * Service interfaces for the refactored Relatr architecture
 * Defines clear boundaries between service responsibilities
 */

import type {
  NostrProfile,
  RelatrConfig,
  CalculateTrustScoreParams,
  SearchProfilesParams,
  SearchProfilesResult,
  StatsResult,
  TrustScore,
} from "../types";
import type { DatabaseManager } from "../database/DatabaseManager";
import type { SocialGraph } from "../graph/SocialGraph";
import type { MetricsValidator } from "../validators/MetricsValidator";
import type { PubkeyMetadataFetcher } from "../graph/PubkeyMetadataFetcher";
import type { MetricsRepository } from "../database/repositories/MetricsRepository";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { SettingsRepository } from "../database/repositories/SettingsRepository";
import type { TrustCalculator } from "../trust/TrustCalculator";

export interface ISearchService {
  searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult>;
  calculateProfileScores(
    profiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    sourcePubkey: string,
    weightingScheme?: string,
  ): Promise<{ pubkey: string; trustScore: number; exactMatch: boolean }[]>;
  calculateRelevanceMultiplier(
    profile: NostrProfile,
    query: string,
  ): { multiplier: number; isExactMatch: boolean };
}

export interface ISchedulerService {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncProfiles(
    force?: boolean,
    hops?: number,
    sourcePubkey?: string,
  ): Promise<void>;
  syncValidations(batchSize?: number, sourcePubkey?: string): Promise<void>;
  processDiscoveryQueue(): Promise<void>;
  queuePubkeyForDiscovery(pubkey: string): void;
  isRunning(): boolean;
  getMetricsStats(): Promise<{ totalEntries: number }>;
}

export interface IRelatrService {
  calculateTrustScore(params: CalculateTrustScoreParams): Promise<TrustScore>;
  searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult>;
  getStats(): Promise<StatsResult>;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
  getConfig(): RelatrConfig;
}

export interface RelatrServiceDependencies {
  config: RelatrConfig;
  dbManager: DatabaseManager;
  socialGraph: SocialGraph;
  metricsValidator: MetricsValidator;
  metadataRepository: MetadataRepository;
  metricsRepository: MetricsRepository;
  settingsRepository: SettingsRepository;
  pubkeyMetadataFetcher: PubkeyMetadataFetcher;
  trustCalculator: TrustCalculator;
  searchService: ISearchService;
  schedulerService: ISchedulerService;
}
