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
import type { TARepository } from "../database/repositories/TARepository";
import type { TrustCalculator } from "../trust/TrustCalculator";
import type { TAService } from "./TAService";
import type { RelayPool } from "applesauce-relay";

export interface ISearchService {
  searchProfiles(params: SearchProfilesParams): Promise<SearchProfilesResult>;
  calculateProfileScores(
    profiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    sourcePubkey: string,
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

export interface ISchedulerServiceDependencies {
  config: RelatrConfig;
  metricsRepository: MetricsRepository;
  socialGraph: SocialGraph;
  metricsValidator: MetricsValidator;
  metadataRepository: MetadataRepository;
  settingsRepository: SettingsRepository;
  pool: RelayPool;
  taService?: TAService;
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

  /**
   * Optional TA repository. TA is an operator-controlled feature and may be disabled.
   */
  taRepository?: TARepository;

  /**
   * Optional TA service. TA is an operator-controlled feature and may be disabled.
   * Used for lazy TA refresh after trust computation.
   */
  taService?: TAService;

  pubkeyMetadataFetcher: PubkeyMetadataFetcher;
  trustCalculator: TrustCalculator;
  searchService: ISearchService;
  schedulerService?: ISchedulerService;
}
