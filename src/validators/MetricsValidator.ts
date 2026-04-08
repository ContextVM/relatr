import type { ProfileMetrics, NostrProfile } from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import type { MetricsRepository } from "@/database/repositories/MetricsRepository";
import type { RelayPool } from "applesauce-relay";
import { executeWithRetry } from "nostr-social-duck";
import { logger } from "@/utils/Logger";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import { nowSeconds } from "@/utils/utils";
import type { IEloPluginEngine } from "../plugins/EloPluginEngine";
import { LruCache } from "@/utils/lru-cache";
import { mapWithConcurrency } from "@/utils/mapWithConcurrency";
import type { CapabilityRunCache } from "../plugins/plugin-types";
import {
  buildPreparedValidationProfiles,
  buildValidationChunkContext,
  executeValidationChunk,
  type ValidationChunkRuntime,
} from "@/validation/ValidationBatchExecution";
import type { ValidationRunContext } from "@/validation/ValidationRunContext";
import {
  RelayProfileFetcher,
  type ProfileFetcher,
} from "@/graph/RelayProfileFetcher";

/**
 * MetricsValidator - Validates profile metrics using Elo plugins only.
 *
 * This class is simplified to work exclusively with Elo portable plugins.
 * TypeScript validators have been deprecated in favor of Elo plugins.
 */
export class MetricsValidator {
  private metricsRepository: MetricsRepository;
  private cacheTtlSeconds: number = 3600;
  private readonly validationChunkSize = 100;
  private readonly validationChunkConcurrency = 2;
  private readonly validationPubkeyConcurrency = 8;
  private metadataRepository: MetadataRepository;
  private eloEngine: IEloPluginEngine;
  private readonly profileFetcher: ProfileFetcher;

  /**
   * Create a new MetricsValidator instance
   * @param pool - Shared RelayPool instance for Nostr operations
   * @param nostrRelays - Array of Nostr relay URLs
   * @param graphManager - SocialGraph instance for graph-based capabilities
   * @param metricsRepository - Repository for storing profile metrics
   * @param metadataRepository - Repository for storing profile metadata
   * @param eloEngine - IEloPluginEngine for Elo plugin metrics
   * @param cacheTtlSeconds - Cache time-to-live in seconds
   */
  constructor(
    pool: RelayPool,
    nostrRelays: string[],
    graphManager: SocialGraph,
    metricsRepository: MetricsRepository,
    metadataRepository: MetadataRepository,
    eloEngine: IEloPluginEngine,
    cacheTtlSeconds?: number,
    profileFetcher?: ProfileFetcher,
  ) {
    if (!pool) {
      throw new ValidationError("RelayPool instance is required");
    }

    if (!nostrRelays || nostrRelays.length === 0) {
      throw new ValidationError("Nostr relays array cannot be empty");
    }

    if (!graphManager) {
      throw new ValidationError("SocialGraph instance is required");
    }

    if (!metricsRepository) {
      throw new ValidationError("MetricsRepository instance is required");
    }

    if (!metadataRepository) {
      throw new ValidationError("MetadataRepository instance is required");
    }

    if (!eloEngine) {
      throw new ValidationError("EloPluginEngine instance is required");
    }

    this.metricsRepository = metricsRepository;
    // cacheTtlSeconds is expressed in SECONDS (used with unix epoch seconds throughout the code).
    // Keep it in seconds to avoid accidentally producing multi-year TTLs.
    this.cacheTtlSeconds = cacheTtlSeconds ?? 60 * 60 * 48;
    this.metadataRepository = metadataRepository;
    this.eloEngine = eloEngine;
    this.profileFetcher =
      profileFetcher ?? new RelayProfileFetcher(pool, nostrRelays);
  }

  /**
   * Validate all metrics for a pubkey
   * Checks cache first, then evaluates Elo plugins if not cached
   * @param pubkey - Target public key to validate
   * @param sourcePubkey - Optional source pubkey for context-dependent capabilities
   * @returns Complete ProfileMetrics object with all validation results
   */
  async validateAll(
    pubkey: string,
    sourcePubkey?: string,
    metricKeys?: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<ProfileMetrics> {
    if (!pubkey || typeof pubkey !== "string") {
      throw new ValidationError("Pubkey must be a non-empty string");
    }

    const expectedMetricKeys = this.getExpectedMetricKeys(metricKeys);
    const now = nowSeconds();

    if (expectedMetricKeys.size === 0) {
      return this.buildProfileMetricsResult(pubkey, {}, now);
    }

    const cached = await this.loadCachedMetrics(pubkey);
    const missingMetricKeys = this.getMissingExpectedMetricKeysForProfile(
      cached,
      expectedMetricKeys,
      validationRunContext,
    );

    if (missingMetricKeys.length === 0 && cached) {
      return cached;
    }

    try {
      // Execute only missing plugin metrics
      const computedMetrics = await this.evaluateEloPlugins(
        pubkey,
        sourcePubkey,
        undefined,
        missingMetricKeys,
        validationRunContext,
      );

      await this.persistComputedMetricSubset(pubkey, computedMetrics);

      return this.buildProfileMetricsResult(
        pubkey,
        this.mergeMetrics(cached, computedMetrics),
        now,
      );
    } catch (error) {
      return this.buildValidationFailureResult(pubkey, now, error);
    }
  }

  /**
   * Validate all metrics for multiple pubkeys in batch
   * Checks cache first for all pubkeys, then validates only those not cached
   * @param pubkeys - Array of target public keys to validate
   * @param sourcePubkey - Optional source pubkey for context-dependent capabilities
   * @returns Map of pubkey to ProfileMetrics
   */
  async validateAllBatch(
    pubkeys: string[],
    sourcePubkey?: string,
    metricKeys?: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<Map<string, ProfileMetrics>> {
    if (!pubkeys || !Array.isArray(pubkeys)) {
      throw new ValidationError("Pubkeys must be a non-empty array");
    }

    if (pubkeys.length === 0) {
      return new Map();
    }

    const results = new Map<string, ProfileMetrics>();
    const now = nowSeconds();
    const expectedMetricKeys = this.getExpectedMetricKeys(metricKeys);

    if (expectedMetricKeys.size === 0) {
      for (const pubkey of pubkeys) {
        results.set(pubkey, {
          pubkey,
          metrics: {},
          computedAt: now,
          expiresAt: now + this.cacheTtlSeconds,
        });
      }

      return results;
    }

    // Per-run capability cache (cross-pubkey dedupe) scoped to this batch call.
    // Keep in-memory only; flush in finally to avoid leaks.
    const capRunCache: CapabilityRunCache = {
      // Cache in-flight promises so concurrent pubkeys dedupe correctly.
      nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(5000),
    };

    try {
      // Check cache for all pubkeys in batch
      const cachedMetrics = await executeWithRetry(async () => {
        return await this.metricsRepository.getBatch(pubkeys);
      });

      const pubkeysToValidate = this.selectBatchValidationTargets({
        pubkeys,
        cachedMetrics,
        expectedMetricKeys,
        results,
        validationRunContext,
      });

      // If all pubkeys were cached, return early
      if (pubkeysToValidate.length === 0) {
        return results;
      }

      const executionChunks = this.createExecutionChunks(pubkeysToValidate);
      const totalExecutionChunks = executionChunks.length;
      const cachedProfiles = await this.prepareProfilesForBatchValidation(
        pubkeysToValidate,
        validationRunContext,
      );

      const sharedChunkContext = {
        now,
        cacheTtlSeconds: this.cacheTtlSeconds,
        expectedMetricKeys,
        cachedMetrics,
        forceRefreshMetricKeys: validationRunContext?.forceRefreshMetricKeys,
        metricsRepository: this.metricsRepository,
        validationPubkeyConcurrency: this.validationPubkeyConcurrency,
        mapWithConcurrency,
        getMissingExpectedMetricKeys: (
          metrics: Record<string, number>,
          keys: Set<string>,
        ) => this.getMissingExpectedMetricKeys(metrics, keys),
      };

      const processExecutionChunk = async (
        chunk: string[],
        chunkNum: number,
      ): Promise<void> => {
        const chunkMetricResults = await this.evaluateEloPluginsBatch(
          chunk,
          sourcePubkey,
          capRunCache,
          expectedMetricKeys,
          cachedMetrics,
          validationRunContext,
        );

        const chunkRuntime: ValidationChunkRuntime = {
          batchMetricResults: chunkMetricResults,
          evaluatePubkeyMetrics: async ({ pubkey, missingMetricKeys }) => {
            return await this.evaluateEloPlugins(
              pubkey,
              sourcePubkey,
              capRunCache,
              missingMetricKeys,
              validationRunContext,
            );
          },
          buildResult: ({ profile, cached, computedMetrics }) => {
            return {
              result: {
                pubkey: profile.pubkey,
                metrics: {
                  ...(cached?.metrics ?? {}),
                  ...computedMetrics,
                },
                computedAt: now,
                expiresAt: now + this.cacheTtlSeconds,
              },
              computedMetrics,
              success: true,
            };
          },
        };

        const chunkExecution = await executeValidationChunk(
          buildValidationChunkContext(
            {
              plan: {
                pubkeys: chunk,
                chunkNumber: chunkNum,
                totalChunks: totalExecutionChunks,
              },
              profileByPubkey: cachedProfiles,
              runtime: chunkRuntime,
            },
            sharedChunkContext,
          ),
        );

        for (const { pubkey, result } of chunkExecution.results) {
          results.set(pubkey, result);
        }
      };

      for (
        let i = 0;
        i < executionChunks.length;
        i += this.validationChunkConcurrency
      ) {
        const batch = executionChunks.slice(
          i,
          i + this.validationChunkConcurrency,
        );
        await Promise.all(
          batch.map((chunk, j) => processExecutionChunk(chunk, i + j + 1)),
        );
      }

      return results;
    } finally {
      capRunCache.nip05Resolve?.clear();
    }
  }

  /**
   * Get metric descriptions registry
   * @returns MetricDescriptionRegistry with all Elo plugin descriptions
   */
  getMetricDescriptions() {
    return this.eloEngine.getMetricDescriptions();
  }

  /**
   * Get resolved plugin weights
   * @returns Record mapping namespaced plugin names to their weights
   */
  getResolvedWeights(): Record<string, number> {
    return this.eloEngine.getResolvedWeights();
  }

  hasConfiguredValidators(): boolean {
    return this.getExpectedMetricKeys().size > 0;
  }

  async getStoredMetrics(
    pubkeys: string[],
    sourcePubkey?: string,
    metricKeys?: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<Map<string, ProfileMetrics>> {
    if (!pubkeys || !Array.isArray(pubkeys)) {
      throw new ValidationError("Pubkeys must be a non-empty array");
    }

    if (pubkeys.length === 0) {
      return new Map();
    }

    const storedMetrics = await executeWithRetry(async () => {
      return await this.metricsRepository.getBatch(pubkeys);
    });
    let storedProfiles = new Map<string, NostrProfile | null>();

    try {
      storedProfiles = await this.metadataRepository.getBatch(pubkeys);
    } catch (error) {
      logger.warn(
        "Stored profile lookup failed while resolving request-time metrics policy:",
        error instanceof Error ? error.message : String(error),
      );
    }

    const missingPubkeys = pubkeys.filter((pubkey) => {
      const cached = storedMetrics.get(pubkey);
      if (cached) {
        return false;
      }

      return !storedProfiles.get(pubkey);
    });

    if (missingPubkeys.length === 0) {
      return new Map(
        pubkeys.flatMap((pubkey) => {
          const cached = storedMetrics.get(pubkey);
          if (cached) {
            return [[pubkey, cached] as const];
          }

          if (storedProfiles.get(pubkey)) {
            return [
              [
                pubkey,
                this.buildProfileMetricsResult(pubkey, {}, nowSeconds()),
              ] as const,
            ];
          }

          return [];
        }),
      );
    }

    const computedMissing = await this.validateAllBatch(
      missingPubkeys,
      sourcePubkey,
      metricKeys,
      validationRunContext,
    );

    return new Map(
      pubkeys.flatMap((pubkey) => {
        const cached = storedMetrics.get(pubkey);
        if (cached) {
          return [[pubkey, cached] as const];
        }

        if (storedProfiles.get(pubkey)) {
          return [
            [
              pubkey,
              this.buildProfileMetricsResult(pubkey, {}, nowSeconds()),
            ] as const,
          ];
        }

        const computed = computedMissing.get(pubkey);
        return computed ? [[pubkey, computed] as const] : [];
      }),
    );
  }

  /**
   * Evaluate Elo plugins for a pubkey
   * @param pubkey - Target public key
   * @param sourcePubkey - Optional source pubkey for context-dependent capabilities
   * @returns Plugin metrics or empty object on error
   * @private
   */
  private async evaluateEloPlugins(
    pubkey: string,
    sourcePubkey?: string,
    capRunCache?: CapabilityRunCache,
    metricKeys?: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<Record<string, number>> {
    try {
      return await this.eloEngine.evaluateForPubkey({
        targetPubkey: pubkey,
        sourcePubkey,
        metricKeys,
        capRunCache,
        validationRunContext,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Elo plugin evaluation failed for ${pubkey}: ${errorMsg}`);
      return {};
    }
  }

  private async evaluateEloPluginsBatch(
    pubkeys: string[],
    sourcePubkey: string | undefined,
    capRunCache: CapabilityRunCache,
    expectedMetricKeys: Set<string>,
    cachedMetrics: Map<string, ProfileMetrics | null>,
    validationRunContext?: ValidationRunContext,
  ): Promise<Map<string, Record<string, number>> | null> {
    const pubkeysToEvaluate: string[] = [];
    const metricKeysToEvaluate = new Set<string>();

    for (const pubkey of pubkeys) {
      const cached = cachedMetrics.get(pubkey) ?? null;
      const missingMetricKeys = this.getMissingExpectedMetricKeysForProfile(
        cached,
        expectedMetricKeys,
      );

      if (missingMetricKeys.length === 0) {
        continue;
      }

      pubkeysToEvaluate.push(pubkey);
      for (const metricKey of missingMetricKeys) {
        metricKeysToEvaluate.add(metricKey);
      }
    }

    if (pubkeysToEvaluate.length === 0) {
      return new Map();
    }

    if (typeof this.eloEngine.evaluateBatchForPubkeys !== "function") {
      return null;
    }

    try {
      return await this.eloEngine.evaluateBatchForPubkeys({
        targetPubkeys: pubkeysToEvaluate,
        sourcePubkey,
        metricKeys: Array.from(metricKeysToEvaluate),
        capRunCache,
        validationRunContext,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Batch Elo plugin evaluation failed: ${errorMsg}`);
      return new Map();
    }
  }

  private createExecutionChunks(pubkeys: string[]): string[][] {
    if (pubkeys.length <= this.validationChunkSize) {
      return [pubkeys];
    }

    const chunks: string[][] = [];
    for (let i = 0; i < pubkeys.length; i += this.validationChunkSize) {
      chunks.push(pubkeys.slice(i, i + this.validationChunkSize));
    }

    return chunks;
  }

  private async prepareProfilesForBatchValidation(
    pubkeysToValidate: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<Map<string, NostrProfile | null>> {
    const cachedProfiles = await this.loadProfilesForBatchValidation(
      pubkeysToValidate,
      validationRunContext,
    );

    const { missingPubkeys: missingProfilePubkeys } =
      buildPreparedValidationProfiles(pubkeysToValidate, cachedProfiles);

    if (
      missingProfilePubkeys.length > 0 &&
      this.hasPreparedMetadataCoverage(pubkeysToValidate, validationRunContext)
    ) {
      logger.warn(
        `Validation batch prepared metadata coverage was incomplete for ${missingProfilePubkeys.length} pubkeys; falling back to relay profile fetch before batch scoring`,
      );
    }

    if (missingProfilePubkeys.length === 0) {
      return cachedProfiles;
    }

    logger.info(
      `🌐 Fetching ${missingProfilePubkeys.length} missing profiles from relays before batch validation`,
    );

    const fetchedProfiles = await this.profileFetcher.fetchProfiles(
      missingProfilePubkeys,
    );

    await this.metadataRepository.saveMany(
      Array.from(fetchedProfiles.values()),
    );

    for (const pubkey of missingProfilePubkeys) {
      cachedProfiles.set(pubkey, fetchedProfiles.get(pubkey) ?? { pubkey });
    }

    return cachedProfiles;
  }

  private hasPreparedMetadataCoverage(
    pubkeys: string[],
    validationRunContext?: ValidationRunContext,
  ): boolean {
    const preparedProfiles = validationRunContext?.preparedMetadataProfiles;
    const preparedCoverage = validationRunContext?.metadataPreparedForPubkeys;

    return (
      !!preparedProfiles &&
      !!preparedCoverage &&
      pubkeys.every((pubkey) => preparedCoverage.has(pubkey))
    );
  }

  private async loadProfilesForBatchValidation(
    pubkeys: string[],
    validationRunContext?: ValidationRunContext,
  ): Promise<Map<string, NostrProfile | null>> {
    if (this.hasPreparedMetadataCoverage(pubkeys, validationRunContext)) {
      const preparedProfiles = validationRunContext?.preparedMetadataProfiles;

      return new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          preparedProfiles?.get(pubkey) ?? null,
        ]),
      );
    }

    return await this.metadataRepository.getBatch(pubkeys);
  }

  private getExpectedMetricKeys(metricKeys?: string[]): Set<string> {
    if (metricKeys && metricKeys.length > 0) {
      return new Set(metricKeys);
    }

    const runtime = this.eloEngine.getRuntimeState();
    const keys = runtime.plugins.map(
      (plugin) => `${plugin.pubkey}:${plugin.manifest.name}`,
    );
    return new Set(keys);
  }

  private getMissingExpectedMetricKeys(
    metrics: Record<string, number>,
    expectedKeys: Set<string>,
  ): string[] {
    const missing: string[] = [];
    for (const key of expectedKeys) {
      if (metrics[key] === undefined) {
        missing.push(key);
      }
    }
    return missing;
  }

  private async loadCachedMetrics(
    pubkey: string,
  ): Promise<ProfileMetrics | null> {
    try {
      return await executeWithRetry(async () => {
        return await this.metricsRepository.get(pubkey);
      });
    } catch (error) {
      logger.warn("Cache read failed, proceeding with validation:", error);
      return null;
    }
  }

  private getMissingExpectedMetricKeysForProfile(
    cached: ProfileMetrics | null | undefined,
    expectedKeys: Set<string>,
    validationRunContext?: ValidationRunContext,
  ): string[] {
    const missing = this.getMissingExpectedMetricKeys(
      cached?.metrics ?? {},
      expectedKeys,
    );
    const forceRefreshMetricKeys = validationRunContext?.forceRefreshMetricKeys;
    if (!forceRefreshMetricKeys || forceRefreshMetricKeys.size === 0) {
      return missing;
    }

    const forcedMissing = new Set(missing);
    for (const key of expectedKeys) {
      if (forceRefreshMetricKeys.has(key)) {
        forcedMissing.add(key);
      }
    }

    return [...forcedMissing];
  }

  private mergeMetrics(
    cached: ProfileMetrics | null | undefined,
    computedMetrics: Record<string, number>,
  ): Record<string, number> {
    return {
      ...(cached?.metrics ?? {}),
      ...computedMetrics,
    };
  }

  private buildProfileMetricsResult(
    pubkey: string,
    metrics: Record<string, number>,
    now: number,
  ): ProfileMetrics {
    return {
      pubkey,
      metrics,
      computedAt: now,
      expiresAt: now + this.cacheTtlSeconds,
    };
  }

  private async persistComputedMetricSubset(
    pubkey: string,
    computedMetrics: Record<string, number>,
  ): Promise<void> {
    if (Object.keys(computedMetrics).length === 0) {
      return;
    }

    try {
      await this.metricsRepository.upsertMetricSubset(pubkey, computedMetrics);
    } catch (error) {
      logger.warn("Cache write failed:", error);
    }
  }

  private buildValidationFailureResult(
    pubkey: string,
    now: number,
    error: unknown,
  ): ProfileMetrics {
    logger.warn(
      `[MetricsValidator] ⚠️ Validation failed for ${pubkey}:`,
      error instanceof Error ? error.message : String(error),
    );

    return this.buildProfileMetricsResult(pubkey, {}, now);
  }

  private selectBatchValidationTargets(input: {
    pubkeys: string[];
    cachedMetrics: Map<string, ProfileMetrics | null>;
    expectedMetricKeys: Set<string>;
    results: Map<string, ProfileMetrics>;
    validationRunContext?: ValidationRunContext;
  }): string[] {
    const pubkeysToValidate: string[] = [];

    for (const pubkey of input.pubkeys) {
      const cached = input.cachedMetrics.get(pubkey);
      const missingMetricKeys = this.getMissingExpectedMetricKeysForProfile(
        cached,
        input.expectedMetricKeys,
        input.validationRunContext,
      );
      if (missingMetricKeys.length === 0 && cached) {
        input.results.set(pubkey, cached);
      } else {
        pubkeysToValidate.push(pubkey);
      }
    }

    return pubkeysToValidate;
  }
}
