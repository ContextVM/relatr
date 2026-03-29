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
import { ValidationPipeline } from "@/validation/ValidationPipeline";
import { MetadataFactRefreshStage } from "@/validation/MetadataFactRefreshStage";
import { CompositeFactRefreshStage } from "@/validation/FactRefreshStage";
import { Nip05FactRefreshStage } from "@/validation/Nip05FactRefreshStage";
import { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";
import { MetadataRefreshTracker } from "@/validation/MetadataRefreshTracker";

export class SchedulerService implements ISchedulerService {
  private discoveryQueue: Set<string> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private validationInterval: NodeJS.Timeout | null = null;
  private validationWarmupQueued = false;
  private validationPipeline: ValidationPipeline;
  private readonly metadataRefreshTracker = new MetadataRefreshTracker();
  private readonly nip05FactRefreshStage: Nip05FactRefreshStage;
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
  ) {
    const nip05CacheStore = new Nip05CacheStore(settingsRepository);
    this.nip05FactRefreshStage = new Nip05FactRefreshStage(
      metadataRepository,
      nip05CacheStore,
      config,
    );

    this.validationPipeline = new ValidationPipeline({
      config,
      socialGraph,
      metricsValidator,
      factRefreshStage: new CompositeFactRefreshStage([
        new MetadataFactRefreshStage(
          metadataRepository,
          pubkeyMetadataFetcher,
          this.metadataRefreshTracker,
        ),
        this.nip05FactRefreshStage,
      ]),
    });
  }

  markBootstrapMetadataFresh(pubkeys: string[], sourcePubkey?: string): void {
    this.metadataRefreshTracker.markBootstrapFresh(pubkeys, sourcePubkey);
  }

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
    hops: number = this.config.numberOfHops,
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
      // Step 1: Get all pubkeys reachable within configured hop distance
      const discoveredPubkeys =
        await this.socialGraph.getUsersUpToDistance(hops);

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
    metricKeys?: string[],
  ): Promise<void> {
    return this.validationPipeline.scheduleValidationSync(
      batchSize,
      sourcePubkey,
      metricKeys,
    );
  }

  scheduleValidationWarmup(sourcePubkey?: string, metricKeys?: string[]): void {
    if (this.validationWarmupQueued) {
      return;
    }

    this.validationWarmupQueued = true;

    queueMicrotask(() => {
      this.validationWarmupQueued = false;
      this.syncValidations(undefined, sourcePubkey, metricKeys).catch(
        (error) => {
          logger.error(
            "Scheduled validation warm-up failed:",
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    });
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
            await this.syncProfiles(false, this.config.numberOfHops);
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
