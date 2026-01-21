import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import type { RelatrConfig } from "../types";
import type { SocialGraph } from "../graph/SocialGraph";
import type { MetricsValidator } from "../validators/MetricsValidator";
import type { PubkeyMetadataFetcher } from "../graph/PubkeyMetadataFetcher";
import type { MetricsRepository } from "../database/repositories/MetricsRepository";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { SettingsRepository } from "../database/repositories/SettingsRepository";
import type { RelayPool } from "applesauce-relay";
import type { ISchedulerService } from "./ServiceInterfaces";
import type { TAService } from "./TAService";
import { RelatrError } from "../types";
import { logger } from "../utils/Logger";
import { nowMs } from "@/utils/utils";

export class SchedulerService implements ISchedulerService {
  private discoveryQueue: Set<string> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private validationInterval: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private _isStarting = false;
  private _isStopping = false;

  constructor(
    private config: RelatrConfig,
    private metricsRepository: MetricsRepository,
    private socialGraph: SocialGraph,
    private metricsValidator: MetricsValidator,
    private metadataRepository: MetadataRepository,
    private pubkeyMetadataFetcher: PubkeyMetadataFetcher,
    private settingsRepository: SettingsRepository,
    private pool: RelayPool,
    private taService?: TAService,
  ) {}

  async start(): Promise<void> {
    if (this._isRunning || this._isStarting) return;

    this._isStarting = true;
    try {
      this._isRunning = true;
      this.startBackgroundCleanup();
      this.startPeriodicSync();

      // IMPORTANT: run initial validation sync before we consider the service "started".
      // This prevents client requests from racing with the first big write workload
      // (metrics batch writes) on the shared DuckDB connection.
      await this.startPeriodicValidationSync();

      logger.info("🔧 SchedulerService background processes started");
    } finally {
      this._isStarting = false;
    }
  }

  async stop(): Promise<void> {
    if (this._isStopping) return;

    this._isStopping = true;
    try {
      this._isRunning = false;

      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = null;
      }
      if (this.validationInterval) {
        clearInterval(this.validationInterval);
        this.validationInterval = null;
      }

      logger.info("🔧 SchedulerService background processes stopped");
    } finally {
      this._isStopping = false;
    }
  }

  async syncProfiles(
    force: boolean = false,
    hops: number = 1,
    sourcePubkey?: string,
  ): Promise<void> {
    logger.info("Starting profile sync and metrics pre-caching...");

    if (
      !this.pool ||
      !this.metricsValidator ||
      !this.socialGraph ||
      !this.metadataRepository ||
      !this.pubkeyMetadataFetcher ||
      !this.settingsRepository
    ) {
      throw new RelatrError(
        "SchedulerService dependencies not properly initialized",
        "NOT_INITIALIZED",
      );
    }

    const startTime = nowMs();
    const effectiveSourcePubkey =
      sourcePubkey || this.config.defaultSourcePubkey;
    const syncKey = `contact_sync:${effectiveSourcePubkey}`;
    logger.info(
      `Syncing profiles for ${hops} hops from ${effectiveSourcePubkey}`,
    );

    try {
      // Check last sync time unless forced
      if (!force) {
        const lastSyncTimeStr = await this.settingsRepository.get(syncKey);

        if (lastSyncTimeStr) {
          const lastSyncTime = parseInt(lastSyncTimeStr);
          if (
            nowMs() - lastSyncTime <
            this.config.syncIntervalHours * 3600 * 1000
          ) {
            logger.info(`Skipping contact sync - last sync was recent.`);
            return;
          }
        }
      }

      logger.info("Starting profile sync and metrics pre-caching...");
      // Step 1: Get all pubkeys from the social graph
      const discoveredPubkeys = await this.socialGraph.getAllUsersInGraph();

      // Step 2: Fetch metadata for ALL pubkeys to ensure we have the latest metadata
      logger.info(
        `📊 Fetching metadata for ${discoveredPubkeys.length.toLocaleString()} pubkeys`,
      );

      await this.pubkeyMetadataFetcher.fetchMetadata({
        pubkeys: discoveredPubkeys,
        sourcePubkey: effectiveSourcePubkey,
      });

      const now = nowMs();
      await this.settingsRepository.set(syncKey, now.toString());

      logger.info(`Sync completed in ${nowMs() - startTime}ms`);
    } catch (error) {
      logger.error(
        "Profile sync error:",
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `Profile sync failed: ${error instanceof Error ? error.message : String(error)}`,
        "SYNC_ERROR",
      );
    }
  }

  async syncValidations(
    batchSize: number = 250,
    sourcePubkey?: string,
  ): Promise<void> {
    logger.info("Starting validation sync...");

    if (
      !this.socialGraph ||
      !this.metricsValidator ||
      !this.metricsRepository
    ) {
      throw new RelatrError(
        "SchedulerService dependencies not properly initialized for validation sync",
        "NOT_INITIALIZED",
      );
    }

    const startTime = nowMs();
    const effectiveSourcePubkey =
      sourcePubkey || this.config.defaultSourcePubkey;

    try {
      // Step 1: Get all pubkeys from the social graph
      const allPubkeys = await this.socialGraph.getAllUsersInGraph();
      logger.info(
        `📊 Found ${allPubkeys.length.toLocaleString()} pubkeys in social graph`,
      );

      // Step 2: Identify pubkeys without validation scores
      const pubkeysWithoutScores =
        await this.metricsRepository.getPubkeysWithoutScores(allPubkeys);
      logger.info(
        `🔍 Found ${pubkeysWithoutScores.length.toLocaleString()} pubkeys missing validation scores`,
      );

      if (pubkeysWithoutScores.length === 0) {
        logger.info("✅ All pubkeys have validation scores, no sync needed");
        return;
      }

      // Step 3: Process validations in batches to avoid overwhelming the system
      let processedCount = 0;
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < pubkeysWithoutScores.length; i += batchSize) {
        const batch = pubkeysWithoutScores.slice(i, i + batchSize);
        logger.info(
          `🔄 Processing validation batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(pubkeysWithoutScores.length / batchSize)} (${batch.length} pubkeys)`,
        );

        try {
          // Use batch validation for the entire batch
          const batchResults = await this.metricsValidator.validateAllBatch(
            batch,
            effectiveSourcePubkey,
          );

          // Count successes and errors
          for (const [pubkey, metrics] of batchResults) {
            processedCount++;
            if (metrics && Object.keys(metrics.metrics || {}).length > 0) {
              successCount++;
            } else {
              errorCount++;
              logger.warn(
                `⚠️ Validation failed for ${pubkey}: No metrics generated`,
              );
            }
          }

          // Log progress
          logger.info(
            `📈 Progress: ${processedCount}/${pubkeysWithoutScores.length} processed, ${successCount} successful, ${errorCount} failed`,
          );
        } catch (error) {
          // If batch validation fails, fall back to individual validations
          logger.warn(
            `Batch validation failed for batch ${Math.floor(i / batchSize) + 1}, falling back to individual validations:`,
            error instanceof Error ? error.message : String(error),
          );

          // Process each pubkey individually as fallback
          for (const pubkey of batch) {
            try {
              await this.metricsValidator.validateAll(
                pubkey,
                effectiveSourcePubkey,
              );
              processedCount++;
              successCount++;
            } catch (error) {
              processedCount++;
              errorCount++;
              logger.warn(
                `⚠️ Validation failed for ${pubkey}:`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          // Log progress after fallback processing
          logger.info(
            `📈 Progress: ${processedCount}/${pubkeysWithoutScores.length} processed, ${successCount} successful, ${errorCount} failed`,
          );
        }
      }

      logger.info(
        `✅ Validation sync completed in ${nowMs() - startTime}ms. Processed: ${processedCount}, Successful: ${successCount}, Failed: ${errorCount}`,
      );
    } catch (error) {
      logger.error(
        "Validation sync error:",
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `Validation sync failed: ${error instanceof Error ? error.message : String(error)}`,
        "VALIDATION_SYNC_ERROR",
      );
    }
  }

  async processDiscoveryQueue(): Promise<void> {
    if (this.discoveryQueue.size === 0) return;

    logger.info(
      `🔄 Processing discovery queue with ${this.discoveryQueue.size} pubkeys...`,
    );
    const startTime = nowMs();

    try {
      const pubkeysToProcess = Array.from(this.discoveryQueue);
      this.discoveryQueue.clear(); // Clear queue immediately to avoid reprocessing

      // Fetch contact events for queued pubkeys with streaming to avoid memory accumulation
      let totalContactEvents = 0;
      await fetchEventsForPubkeys(pubkeysToProcess, 3, undefined, this.pool, {
        onBatch: async (events, batchIndex, totalBatches) => {
          totalContactEvents += events.length;

          // Process contact events immediately to integrate into graph
          if (events.length > 0 && this.socialGraph) {
            await this.socialGraph.processContactEvents(events);
            logger.debug(
              `✅ Integrated batch ${batchIndex}/${totalBatches} with ${events.length} contact events into social graph`,
            );
          }
        },
      });

      logger.info(
        `📥 Fetched ${totalContactEvents} contact events for ${pubkeysToProcess.length} pubkeys`,
      );

      if (totalContactEvents > 0) {
        logger.info(
          `✅ Integrated ${totalContactEvents} contact events into social graph`,
        );
      }

      logger.info(
        `Discovery queue processing completed in ${nowMs() - startTime}ms`,
      );
    } catch (error) {
      logger.error(
        "Discovery queue processing failed:",
        error instanceof Error ? error.message : String(error),
      );
      // Don't throw - this is background processing and shouldn't break the main flow
    }
  }

  queuePubkeyForDiscovery(pubkey: string): void {
    this.discoveryQueue.add(pubkey);
    logger.debug(`📥 Queued ${pubkey} for contact discovery`);
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  async getMetricsStats(): Promise<{ totalEntries: number }> {
    if (!this.metricsRepository) {
      return { totalEntries: 0 };
    }
    return await this.metricsRepository.getStats();
  }

  /**
   * Start background cache cleanup process
   * @private
   */
  private startBackgroundCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(
      async () => {
        try {
          if (this.metricsRepository && this.isRunning()) {
            const deleted = await this.metricsRepository.cleanup();
            // Only log if entries were actually deleted
            if (deleted > 0) {
              logger.info(
                `Background cleanup completed: ${deleted} expired entries removed`,
              );
            }
          }
        } catch (error) {
          // Log error but don't crash the service
          logger.error(
            "Background cleanup failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      this.config.cleanupIntervalHours * 3600 * 1000,
    );
  }

  /**
   * Start periodic background sync
   * @private
   */
  private startPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.syncInterval = setInterval(
      async () => {
        try {
          if (this.isRunning()) {
            logger.info("Starting periodic background sync...");
            await this.syncProfiles(false, 1);
            logger.info("Periodic sync completed");
          }
        } catch (error) {
          // Log error but don't crash the service
          logger.error(
            "Periodic sync failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      this.config.syncIntervalHours * 3600 * 1000,
    );
  }

  /**
   * Start periodic validation sync
   * @private
   */
  private async startPeriodicValidationSync(): Promise<void> {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }

    // Await the initial run (gates readiness).
    await this.syncValidations();

    this.validationInterval = setInterval(
      async () => {
        try {
          if (this.isRunning()) {
            logger.info("Starting periodic validation sync...");
            await this.syncValidations();
            logger.info("Periodic validation sync completed");

            // Refresh TA ranks after validation sync completes
            if (this.taService) {
              try {
                await this.taService.refreshStaleRanks();
              } catch (error) {
                logger.error(
                  "TA refresh failed:",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }

            if (this.discoveryQueue.size > 0) {
              await this.processDiscoveryQueue();
            }
          }
        } catch (error) {
          // Log error but don't crash the service
          logger.error(
            "Periodic validation sync failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      this.config.validationSyncIntervalHours * 3600 * 1000,
    );
  }
}
