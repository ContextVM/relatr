import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import type { MetricsRepository } from "@/database/repositories/MetricsRepository";
import type { NostrProfile, ProfileMetrics } from "@/types";
import { logger } from "@/utils/Logger";

export type ValidationBatchMapWithConcurrency = <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
) => Promise<R[]>;

export interface ValidationBatchExecutionContext {
  pubkeys: string[];
  chunkNumber: number;
  totalChunks: number;
  now: number;
  cacheTtlSeconds: number;
  expectedMetricKeys: Set<string>;
  cachedMetrics: Map<string, ProfileMetrics | null>;
  metadataRepository: MetadataRepository;
  metricsRepository: MetricsRepository;
  profileFetchConcurrency: number;
  validationPubkeyConcurrency: number;
  mapWithConcurrency: ValidationBatchMapWithConcurrency;
  fetchProfile: (pubkey: string) => Promise<NostrProfile>;
  evaluateMetrics: (input: {
    profile: NostrProfile;
    cached: ProfileMetrics | null;
    missingMetricKeys: string[];
  }) => Promise<{
    result: ProfileMetrics;
    computedMetrics: Record<string, number>;
    success: boolean;
  }>;
  getMissingExpectedMetricKeys: (
    metrics: Record<string, number>,
    expectedKeys: Set<string>,
  ) => string[];
}

export interface ValidationChunkExecutionResult {
  results: Array<{
    pubkey: string;
    result: ProfileMetrics;
    computedMetrics: Record<string, number>;
    success: boolean;
  }>;
}

export async function executeValidationChunk(
  context: ValidationBatchExecutionContext,
): Promise<ValidationChunkExecutionResult> {
  const {
    pubkeys,
    chunkNumber,
    totalChunks,
    now,
    cacheTtlSeconds,
    expectedMetricKeys,
    cachedMetrics,
    metadataRepository,
    metricsRepository,
    profileFetchConcurrency,
    validationPubkeyConcurrency,
    mapWithConcurrency,
    fetchProfile,
    evaluateMetrics,
    getMissingExpectedMetricKeys,
  } = context;

  logger.info(
    `🔄 Processing validation chunk ${chunkNumber} of ${totalChunks} (${pubkeys.length} pubkeys)`,
  );

  const cachedProfiles = await metadataRepository.getBatch(pubkeys);
  const chunkProfiles: NostrProfile[] = [];
  const chunkPubkeysToFetch: string[] = [];

  for (const pubkey of pubkeys) {
    const cachedProfile = cachedProfiles.get(pubkey);
    if (cachedProfile) {
      chunkProfiles.push(cachedProfile);
    } else {
      chunkPubkeysToFetch.push(pubkey);
    }
  }

  if (chunkPubkeysToFetch.length > 0) {
    logger.info(
      `🌐 Fetching ${chunkPubkeysToFetch.length} missing profiles from relays for chunk ${chunkNumber}`,
    );
    const fetchedProfiles = await mapWithConcurrency(
      chunkPubkeysToFetch,
      profileFetchConcurrency,
      async (pubkey) => await fetchProfile(pubkey),
    );
    chunkProfiles.push(...fetchedProfiles);
  }

  const results = await mapWithConcurrency(
    chunkProfiles,
    validationPubkeyConcurrency,
    async (profile) => {
      try {
        const cached = cachedMetrics.get(profile.pubkey) ?? null;
        const missingMetricKeys = getMissingExpectedMetricKeys(
          cached?.metrics ?? {},
          expectedMetricKeys,
        );

        return {
          pubkey: profile.pubkey,
          ...(await evaluateMetrics({
            profile,
            cached,
            missingMetricKeys,
          })),
        };
      } catch (error) {
        logger.warn(
          `[MetricsValidator] ⚠️ Validation failed for ${profile.pubkey}:`,
          error instanceof Error ? error.message : String(error),
        );

        return {
          pubkey: profile.pubkey,
          result: {
            pubkey: profile.pubkey,
            metrics: {},
            computedAt: now,
            expiresAt: now + cacheTtlSeconds,
          },
          computedMetrics: {},
          success: false,
        };
      }
    },
  );

  const subsetUpserts: Array<{
    pubkey: string;
    metrics: Record<string, number>;
  }> = [];

  for (const { pubkey, success, computedMetrics } of results) {
    if (success && Object.keys(computedMetrics).length > 0) {
      subsetUpserts.push({ pubkey, metrics: computedMetrics });
    }
  }

  if (subsetUpserts.length > 0) {
    try {
      await metricsRepository.upsertMetricSubsetBatch(subsetUpserts);
    } catch (error) {
      logger.warn("Chunk batch cache write failed:", error);
    }
  }

  return { results };
}
