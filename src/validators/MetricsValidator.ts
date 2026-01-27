import type { ProfileMetrics, NostrProfile } from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import type { MetricsRepository } from "@/database/repositories/MetricsRepository";
import type { RelayPool } from "applesauce-relay";
import { executeWithRetry, type NostrEvent } from "nostr-social-duck";
import { logger } from "@/utils/Logger";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import { nowSeconds } from "@/utils/utils";
import type { IEloPluginEngine } from "../plugins/EloPluginEngine";
import { LruCache } from "@/utils/lru-cache";
import type { CapabilityRunCache } from "../plugins/plugin-types";

/**
 * MetricsValidator - Validates profile metrics using Elo plugins only.
 *
 * This class is simplified to work exclusively with Elo portable plugins.
 * TypeScript validators have been deprecated in favor of Elo plugins.
 */
export class MetricsValidator {
  private pool: RelayPool;
  private nostrRelays: string[];
  private graphManager: SocialGraph;
  private metricsRepository: MetricsRepository;
  private timeoutMs: number = 10000;
  private cacheTtlSeconds: number = 3600;
  private metadataRepository: MetadataRepository;
  private eloEngine: IEloPluginEngine;

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

    this.pool = pool;
    this.nostrRelays = nostrRelays;
    this.graphManager = graphManager;
    this.metricsRepository = metricsRepository;
    // cacheTtlSeconds is expressed in SECONDS (used with unix epoch seconds throughout the code).
    // Keep it in seconds to avoid accidentally producing multi-year TTLs.
    this.cacheTtlSeconds = cacheTtlSeconds ?? 60 * 60 * 48;
    this.metadataRepository = metadataRepository;
    this.eloEngine = eloEngine;
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
  ): Promise<ProfileMetrics> {
    if (!pubkey || typeof pubkey !== "string") {
      throw new ValidationError("Pubkey must be a non-empty string");
    }
    try {
      // Check cache first
      const cached = await executeWithRetry(async () => {
        return await this.metricsRepository.get(pubkey);
      });
      if (cached) {
        return cached;
      }
    } catch (error) {
      // Cache error shouldn't prevent validation
      logger.warn("Cache read failed, proceeding with validation:", error);
    }

    const now = nowSeconds();

    try {
      // Execute Elo plugins
      const eloMetrics = await this.evaluateEloPlugins(pubkey, sourcePubkey);

      const result: ProfileMetrics = {
        pubkey,
        metrics: eloMetrics,
        computedAt: now,
        expiresAt: now + this.cacheTtlSeconds,
      };

      // Cache the results
      try {
        await this.metricsRepository.save(pubkey, result);
      } catch (error) {
        // Cache error shouldn't prevent returning results
        logger.warn("Cache write failed:", error);
      }

      return result;
    } catch (error) {
      // Return a default metrics object on validation errors
      logger.warn(
        `[MetricsValidator] ⚠️ Validation failed for ${pubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      const errorMetrics: ProfileMetrics = {
        pubkey,
        metrics: {},
        computedAt: now,
        expiresAt: now + this.cacheTtlSeconds,
      };

      return errorMetrics;
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
  ): Promise<Map<string, ProfileMetrics>> {
    if (!pubkeys || !Array.isArray(pubkeys)) {
      throw new ValidationError("Pubkeys must be a non-empty array");
    }

    if (pubkeys.length === 0) {
      return new Map();
    }

    const results = new Map<string, ProfileMetrics>();
    const now = nowSeconds();

    // Per-run capability cache (cross-pubkey dedupe) scoped to this batch call.
    // Keep in-memory only; flush in finally to avoid leaks.
    const capRunCache: CapabilityRunCache = {
      // Cache in-flight promises so concurrent pubkeys dedupe correctly.
      nip05Resolve: new LruCache<Promise<{ pubkey: string | null }>>(5000),
      // Fail-fast cache for domains that have timed out during this run.
      // Keeps retry storms from multiplying across pubkeys.
      nip05BadDomains: new LruCache<true>(2000),
    };

    try {
      // Check cache for all pubkeys in batch
      const cachedMetrics = await executeWithRetry(async () => {
        return await this.metricsRepository.getBatch(pubkeys);
      });

      // Identify pubkeys that need validation (not in cache or expired)
      const pubkeysToValidate: string[] = [];
      for (const pubkey of pubkeys) {
        const cached = cachedMetrics.get(pubkey);
        if (cached) {
          results.set(pubkey, cached);
        } else {
          pubkeysToValidate.push(pubkey);
        }
      }

      // If all pubkeys were cached, return early
      if (pubkeysToValidate.length === 0) {
        return results;
      }

      // Process validation in smaller chunks to avoid memory spikes.
      // Run chunks with bounded parallelism.
      const CHUNK_SIZE = 100;
      const CHUNK_CONCURRENCY = 2;

      const chunks: string[][] = [];
      for (let i = 0; i < pubkeysToValidate.length; i += CHUNK_SIZE) {
        chunks.push(pubkeysToValidate.slice(i, i + CHUNK_SIZE));
      }

      const totalChunks = chunks.length;

      const processChunk = async (
        chunk: string[],
        chunkNum: number,
      ): Promise<void> => {
        logger.info(
          `Processing validation chunk ${chunkNum} of ${totalChunks} (${chunk.length} pubkeys)`,
        );

        // Fetch profiles for this chunk
        const cachedProfiles = await this.metadataRepository.getBatch(chunk);
        const chunkProfiles: NostrProfile[] = [];
        const chunkPubkeysToFetch: string[] = [];

        for (const pubkey of chunk) {
          const cachedProfile = cachedProfiles.get(pubkey);
          if (cachedProfile) {
            chunkProfiles.push(cachedProfile);
          } else {
            chunkPubkeysToFetch.push(pubkey);
          }
        }

        // Fetch remaining profiles from relays in parallel for this chunk
        if (chunkPubkeysToFetch.length > 0) {
          const fetchedProfiles = await Promise.all(
            chunkPubkeysToFetch.map(
              async (pubkey) => await this.fetchProfile(pubkey),
            ),
          );
          chunkProfiles.push(...fetchedProfiles);
        }

        // Validate this chunk in parallel
        const validationPromises = chunkProfiles.map(async (profile) => {
          try {
            const eloMetrics = await this.evaluateEloPlugins(
              profile.pubkey,
              sourcePubkey,
              capRunCache,
            );

            const result: ProfileMetrics = {
              pubkey: profile.pubkey,
              metrics: eloMetrics,
              computedAt: now,
              expiresAt: now + this.cacheTtlSeconds,
            };

            return { pubkey: profile.pubkey, result, success: true };
          } catch (error) {
            logger.warn(
              `[MetricsValidator] ⚠️ Validation failed for ${profile.pubkey}:`,
              error instanceof Error ? error.message : String(error),
            );
            const errorMetrics: ProfileMetrics = {
              pubkey: profile.pubkey,
              metrics: {},
              computedAt: now,
              expiresAt: now + this.cacheTtlSeconds,
            };
            return {
              pubkey: profile.pubkey,
              result: errorMetrics,
              success: false,
            };
          }
        });

        const chunkValidationResults = await Promise.all(validationPromises);

        // Process chunk results and save immediately
        const chunkSuccessfulResults: ProfileMetrics[] = [];
        for (const { pubkey, result, success } of chunkValidationResults) {
          results.set(pubkey, result);
          if (success) {
            chunkSuccessfulResults.push(result);
          }
        }

        if (chunkSuccessfulResults.length > 0) {
          try {
            await this.metricsRepository.saveBatch(chunkSuccessfulResults);
          } catch (error) {
            logger.warn("Chunk batch cache write failed:", error);
          }
        }
      };

      for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
        const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
        await Promise.all(
          batch.map((chunk, j) => processChunk(chunk, i + j + 1)),
        );
      }

      return results;
    } catch (error) {
      // If batch validation fails, fall back to individual validations
      logger.warn(
        "Batch validation failed, falling back to individual validations:",
        error,
      );

      const fallbackResults = new Map<string, ProfileMetrics>();
      for (const pubkey of pubkeys) {
        try {
          const result = await this.validateAll(pubkey, sourcePubkey);
          fallbackResults.set(pubkey, result);
        } catch (error) {
          logger.warn(
            `[MetricsValidator] ⚠️ Validation failed for ${pubkey}:`,
            error instanceof Error ? error.message : String(error),
          );
          const errorMetrics: ProfileMetrics = {
            pubkey,
            metrics: {},
            computedAt: now,
            expiresAt: now + this.cacheTtlSeconds,
          };
          fallbackResults.set(pubkey, errorMetrics);
        }
      }
      return fallbackResults;
    } finally {
      capRunCache.nip05Resolve?.clear();
      capRunCache.nip05BadDomains?.clear();
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

  /**
   * Fetch Nostr profile from relays
   * @param pubkey - Public key to fetch profile for
   * @returns Nostr profile object
   */
  private async fetchProfile(pubkey: string): Promise<NostrProfile> {
    try {
      const event = await new Promise<NostrEvent | null>((resolve, reject) => {
        const subscription = this.pool
          .request(this.nostrRelays, {
            kinds: [0], // Metadata event
            authors: [pubkey],
            limit: 1,
          })
          .subscribe({
            next: (event) => {
              resolve(event);
              subscription.unsubscribe();
            },
            error: (error) => {
              reject(error);
            },
          });

        // Auto-unsubscribe after timeout to prevent hanging subscriptions
        setTimeout(() => {
          subscription.unsubscribe();
          resolve(null);
        }, this.timeoutMs);
      });

      if (!event || !event.content) {
        return { pubkey };
      }

      // Parse profile content with error handling
      try {
        const profile = JSON.parse(event.content) as Partial<NostrProfile>;
        return {
          pubkey,
          name: profile.name,
          display_name: profile.display_name,
          picture: profile.picture,
          nip05: profile.nip05,
          lud16: profile.lud16,
          about: profile.about,
        };
      } catch {
        // Return minimal profile on parse error
        return { pubkey };
      }
    } catch {
      // Return minimal profile on error
      return { pubkey };
    }
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
  ): Promise<Record<string, number>> {
    try {
      return await this.eloEngine.evaluateForPubkey({
        targetPubkey: pubkey,
        sourcePubkey,
        capRunCache,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Elo plugin evaluation failed for ${pubkey}: ${errorMsg}`);
      return {};
    }
  }
}
