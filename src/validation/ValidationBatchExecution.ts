import type { MetricsRepository } from "@/database/repositories/MetricsRepository";
import type { NostrProfile, ProfileMetrics } from "@/types";
import { logger } from "@/utils/Logger";

export type ValidationBatchMapWithConcurrency = <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
) => Promise<R[]>;

export interface ValidationBatchExecutionContext {
  profiles: NostrProfile[];
  pubkeys: string[];
  chunkNumber: number;
  totalChunks: number;
  now: number;
  cacheTtlSeconds: number;
  expectedMetricKeys: Set<string>;
  cachedMetrics: Map<string, ProfileMetrics | null>;
  metricsRepository: MetricsRepository;
  validationPubkeyConcurrency: number;
  mapWithConcurrency: ValidationBatchMapWithConcurrency;
  batchMetricResults: Map<string, Record<string, number>> | null;
  evaluatePubkeyMetrics: (input: {
    pubkey: string;
    missingMetricKeys: string[];
  }) => Promise<Record<string, number>>;
  buildResult: (input: {
    profile: NostrProfile;
    cached: ProfileMetrics | null;
    computedMetrics: Record<string, number>;
  }) => {
    result: ProfileMetrics;
    computedMetrics: Record<string, number>;
    success: boolean;
  };
  getMissingExpectedMetricKeys: (
    metrics: Record<string, number>,
    expectedKeys: Set<string>,
  ) => string[];
}

export interface ValidationChunkRuntime {
  batchMetricResults: Map<string, Record<string, number>> | null;
  evaluatePubkeyMetrics: (input: {
    pubkey: string;
    missingMetricKeys: string[];
  }) => Promise<Record<string, number>>;
  buildResult: (input: {
    profile: NostrProfile;
    cached: ProfileMetrics | null;
    computedMetrics: Record<string, number>;
  }) => {
    result: ProfileMetrics;
    computedMetrics: Record<string, number>;
    success: boolean;
  };
}

export interface ValidationChunkPlan {
  pubkeys: string[];
  chunkNumber: number;
  totalChunks: number;
}

export interface ValidationChunkPreparationInput {
  plan: ValidationChunkPlan;
  profileByPubkey: Map<string, NostrProfile | null>;
  runtime: ValidationChunkRuntime;
}

export interface PreparedValidationProfiles {
  profilesByPubkey: Map<string, NostrProfile | null>;
  missingPubkeys: string[];
}

export function buildPreparedValidationProfiles(
  pubkeys: string[],
  profileByPubkey: Map<string, NostrProfile | null>,
): PreparedValidationProfiles {
  const profilesByPubkey = new Map<string, NostrProfile | null>();
  const missingPubkeys: string[] = [];

  for (const pubkey of pubkeys) {
    const profile = profileByPubkey.get(pubkey) ?? null;
    profilesByPubkey.set(pubkey, profile);

    if (profile === null) {
      missingPubkeys.push(pubkey);
    }
  }

  return {
    profilesByPubkey,
    missingPubkeys,
  };
}

export function buildValidationChunkContext(
  input: ValidationChunkPreparationInput,
  shared: Omit<
    ValidationBatchExecutionContext,
    | "profiles"
    | "pubkeys"
    | "chunkNumber"
    | "totalChunks"
    | "batchMetricResults"
    | "evaluatePubkeyMetrics"
    | "buildResult"
  >,
): ValidationBatchExecutionContext {
  const preparedProfiles = buildPreparedValidationProfiles(
    input.plan.pubkeys,
    input.profileByPubkey,
  );
  const profiles = Array.from(
    preparedProfiles.profilesByPubkey.values(),
  ).filter((profile): profile is NostrProfile => profile !== null);

  return {
    ...shared,
    pubkeys: input.plan.pubkeys,
    chunkNumber: input.plan.chunkNumber,
    totalChunks: input.plan.totalChunks,
    profiles,
    ...input.runtime,
  };
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
    metricsRepository,
    validationPubkeyConcurrency,
    mapWithConcurrency,
    batchMetricResults,
    evaluatePubkeyMetrics,
    buildResult,
    getMissingExpectedMetricKeys,
  } = context;

  logger.info(
    `🔄 Processing validation chunk ${chunkNumber} of ${totalChunks} (${pubkeys.length} pubkeys)`,
  );

  const chunkProfiles = context.profiles;
  const preparedPubkeys = new Set(
    chunkProfiles.map((profile) => profile.pubkey),
  );
  const missingProfiles = pubkeys.filter(
    (pubkey) => !preparedPubkeys.has(pubkey),
  );

  if (missingProfiles.length > 0) {
    logger.warn(
      `Validation chunk ${chunkNumber} started without ${missingProfiles.length} prepared metadata profiles; those pubkeys will be skipped in batch scoring`,
    );
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

        const computedMetrics = batchMetricResults
          ? Object.fromEntries(
              Object.entries(
                batchMetricResults.get(profile.pubkey) ?? {},
              ).filter(([key]) => missingMetricKeys.includes(key)),
            )
          : await evaluatePubkeyMetrics({
              pubkey: profile.pubkey,
              missingMetricKeys,
            });

        return {
          pubkey: profile.pubkey,
          ...buildResult({
            profile,
            cached,
            computedMetrics,
          }),
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
