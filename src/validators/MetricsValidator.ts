import type { ProfileMetrics, MetricWeights, NostrProfile } from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import {
  ValidationRegistry,
  type ValidationContext,
  ALL_PLUGINS,
  type ValidationPlugin,
} from "./plugins";
import type { MetricsRepository } from "@/database/repositories/MetricsRepository";
import type { RelayPool } from "applesauce-relay";
import { executeWithRetry, type NostrEvent } from "nostr-social-duck";
import { logger } from "@/utils/Logger";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";

/**
 * Consolidated validator class for all profile metrics
 * Implements NIP-05, Lightning, Event, and Reciprocity validations
 */
export class MetricsValidator {
  private pool: RelayPool;
  private nostrRelays: string[];
  private graphManager: SocialGraph;
  private metricsRepository: MetricsRepository;
  private timeoutMs: number = 10000;
  private cacheTtlSeconds: number = 3600;
  private registry: ValidationRegistry;
  private metadataRepository: MetadataRepository;

  /**
   * Create a new MetricsValidator instance
   * @param pool - Shared RelayPool instance for Nostr operations
   * @param nostrRelays - Array of Nostr relay URLs
   * @param graphManager - SocialGraph instance for reciprocity checks
   * @param metricsRepository - Repository for storing profile metrics
   * @param plugins - Array of validation plugins to register (defaults to all available plugins)
   */
  constructor(
    pool: RelayPool,
    nostrRelays: string[],
    graphManager: SocialGraph,
    metricsRepository: MetricsRepository,
    metadataRepository: MetadataRepository,
    cacheTtlSeconds?: number,
    plugins: ValidationPlugin[] = ALL_PLUGINS,
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

    this.pool = pool;
    this.nostrRelays = nostrRelays;
    this.graphManager = graphManager;
    this.metricsRepository = metricsRepository;
    this.cacheTtlSeconds = cacheTtlSeconds || 60 * 60 * 1000 * 48;
    this.metadataRepository = metadataRepository;

    // Create registry
    this.registry = new ValidationRegistry();

    // Register provided plugins
    for (const plugin of plugins) {
      this.registry.register(plugin);
    }
  }

  /**
   * Validate all metrics for a pubkey
   * Checks cache first, then validates all registered plugins if not cached
   * @param pubkey - Target public key to validate
   * @param sourcePubkey - Optional source pubkey for reciprocity validation
   * @param searchQuery - Optional search query for context-aware validations
   * @returns Complete ProfileMetrics object with all validation results
   */
  async validateAll(
    pubkey: string,
    sourcePubkey?: string,
    searchQuery?: string,
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

    const now = Math.floor(Date.now() / 1000);

    try {
      // Get profile for validations
      const profile =
        (await this.metadataRepository.get(pubkey)) ||
        (await this.fetchProfile(pubkey));

      // Create validation context
      const context: ValidationContext = {
        pubkey,
        sourcePubkey,
        searchQuery,
        profile,
        graphManager: this.graphManager,
        pool: this.pool,
        relays: this.nostrRelays,
      };

      // Execute all registered plugins
      const metrics = await this.registry.executeAll(context);

      const result: ProfileMetrics = {
        pubkey,
        metrics,
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
   * @param sourcePubkey - Optional source pubkey for reciprocity validation
   * @param searchQuery - Optional search query for context-aware validations
   * @returns Map of pubkey to ProfileMetrics
   */
  async validateAllBatch(
    pubkeys: string[],
    sourcePubkey?: string,
    searchQuery?: string,
  ): Promise<Map<string, ProfileMetrics>> {
    if (!pubkeys || !Array.isArray(pubkeys)) {
      throw new ValidationError("Pubkeys must be a non-empty array");
    }

    if (pubkeys.length === 0) {
      return new Map();
    }

    const results = new Map<string, ProfileMetrics>();
    const now = Math.floor(Date.now() / 1000);

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

      // Process validation in smaller chunks to avoid memory spikes
      const CHUNK_SIZE = 100;
      const successfulResults: ProfileMetrics[] = [];

      for (let i = 0; i < pubkeysToValidate.length; i += CHUNK_SIZE) {
        const chunk = pubkeysToValidate.slice(i, i + CHUNK_SIZE);
        logger.debug(
          `Processing validation chunk ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(pubkeysToValidate.length / CHUNK_SIZE)}`,
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
            const context: ValidationContext = {
              pubkey: profile.pubkey,
              sourcePubkey,
              searchQuery,
              profile,
              graphManager: this.graphManager,
              pool: this.pool,
              relays: this.nostrRelays,
            };

            const metrics = await this.registry.executeAll(context);

            const result: ProfileMetrics = {
              pubkey: profile.pubkey,
              metrics,
              computedAt: now,
              expiresAt: now + this.cacheTtlSeconds,
            };

            return { pubkey: profile.pubkey, result, success: true };
          } catch (error) {
            // Return default metrics on validation errors
            logger.warn(
              `[MetricsValidator] ️ Validation failed for ${profile.pubkey}:`,
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

        // Save this chunk's successful results immediately
        if (chunkSuccessfulResults.length > 0) {
          try {
            await this.metricsRepository.saveBatch(chunkSuccessfulResults);
            successfulResults.push(...chunkSuccessfulResults);
          } catch (error) {
            logger.warn("Chunk batch cache write failed:", error);
          }
        }

        // Clear arrays to free memory
        chunkProfiles.length = 0;
        chunkPubkeysToFetch.length = 0;
        chunkSuccessfulResults.length = 0;
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
          const result = await this.validateAll(
            pubkey,
            sourcePubkey,
            searchQuery,
          );
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
    }
  }

  /**
   * Register a custom validation plugin
   * @param plugin - Validation plugin to register
   */
  registerPlugin(plugin: ValidationPlugin): void {
    this.registry.register(plugin);
  }

  /**
   * Get all registered validation plugins
   * @returns Array of registered plugins
   */
  getRegisteredPlugins(): ValidationPlugin[] {
    return this.registry.getAll();
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
          .request(
            this.nostrRelays,
            {
              kinds: [0], // Metadata event
              authors: [pubkey],
              limit: 1,
            },
            {
              retries: 1,
            },
          )
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
}
