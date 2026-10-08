import { fetchEventsForPubkeys, fetchLastSeenAt } from "@/utils/utils.nostr";
import type { RelatrConfig } from "../types";
import type { SocialGraph } from "../graph/SocialGraph";
import type { MetricsValidator } from "../validators/MetricsValidator";
import type { PubkeyMetadataFetcher } from "../graph/PubkeyMetadataFetcher";
import type { MetricsRepository } from "../database/repositories/MetricsRepository";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { SettingsRepository } from "../database/repositories/SettingsRepository";
import type { RelayPool } from "applesauce-relay";
import type { PubkeyKvRepository } from "../database/repositories/PubkeyKvRepository";
import { PUBKEY_KV_KEYS } from "@/constants/pubkeyKv";
import type { ISchedulerService } from "./ServiceInterfaces";
import type { TAService } from "./TAService";
import { RelatrError } from "../types";
import { logger } from "../utils/Logger";
import { nowMs, nowSeconds } from "@/utils/utils";
import { ValidationPipeline } from "@/validation/ValidationPipeline";
import { MetadataFactRefreshStage } from "@/validation/MetadataFactRefreshStage";
import { CompositeFactRefreshStage } from "@/validation/FactRefreshStage";
import { Nip05FactRefreshStage } from "@/validation/Nip05FactRefreshStage";
import { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";

/** A pubkey counts as recently active if it published any event within this window. */
const ACTIVITY_WINDOW_SECONDS = 30 * 24 * 3600;
const ACTIVITY_SCAN_SETTINGS_KEY = "activity_scan:last_run";

export class SchedulerService implements ISchedulerService {
  private discoveryQueue: Set<string> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private validationInterval: NodeJS.Timeout | null = null;
  private queuedValidationWarmupRequest: {
    sourcePubkey?: string;
    metricKeys?: string[];
    forceRefreshMetricKeys?: string[];
  } | null = null;
  private validationPipeline: ValidationPipeline;
  private readonly nip05FactRefreshStage: Nip05FactRefreshStage;
  private _isRunning = false;
  private _isStarting = false;
  private _isStopping = false;
  private activityScan: Promise<void> | null = null;

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
    private pubkeyKvRepository?: PubkeyKvRepository,
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
        ),
        this.nip05FactRefreshStage,
      ]),
      orderPubkeys: (pubkeys) => this.orderByRecentActivity(pubkeys),
    });
  }

  async start(): Promise<void> {
    if (this._isRunning || this._isStarting) return;

    this._isStarting = true;
    try {
      this._isRunning = true;
      this.startBackgroundCleanup();
      this.startPeriodicSync();

      void this.startPeriodicValidationSync().catch((error) => {
        logger.error(
          "Initial validation warm-up failed:",
          error instanceof Error ? error.message : String(error),
        );
      });

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
    forceRefreshMetricKeys?: string[],
  ): Promise<void> {
    return this.validationPipeline.scheduleValidationSync(
      batchSize,
      sourcePubkey,
      metricKeys,
      forceRefreshMetricKeys,
    );
  }

  scheduleValidationWarmup(
    sourcePubkey?: string,
    metricKeys?: string[],
    forceRefreshMetricKeys?: string[],
  ): void {
    this.queuedValidationWarmupRequest = {
      sourcePubkey,
      metricKeys: metricKeys ? [...metricKeys] : undefined,
      forceRefreshMetricKeys: forceRefreshMetricKeys
        ? [...forceRefreshMetricKeys]
        : undefined,
    };

    queueMicrotask(() => {
      const queuedRequest = this.queuedValidationWarmupRequest;
      if (!queuedRequest) {
        return;
      }

      this.queuedValidationWarmupRequest = null;
      this.syncValidations(
        undefined,
        queuedRequest.sourcePubkey,
        queuedRequest.metricKeys,
        queuedRequest.forceRefreshMetricKeys,
      ).catch((error) => {
        logger.error(
          "Scheduled validation warm-up failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
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

  /**
   * Orders validation targets so recently active pubkeys are scored first. Every pubkey stays in
   * the run; activity only decides the order. Pubkeys never seen active keep their graph order at
   * the end. Activity is best-effort: if it cannot be determined, the graph order is used.
   *
   * Only the very first run waits for the activity scan. Later runs order by the previous scan
   * while a due scan refreshes the data in the background for the next run.
   */
  private async orderByRecentActivity(pubkeys: string[]): Promise<string[]> {
    if (!this.pubkeyKvRepository) {
      return pubkeys;
    }

    try {
      let lastSeen = await this.pubkeyKvRepository.getAllForKey(
        PUBKEY_KV_KEYS.last_seen_at,
      );
      if (lastSeen.size === 0) {
        await this.refreshActivityIfDue(pubkeys);
        lastSeen = await this.pubkeyKvRepository.getAllForKey(
          PUBKEY_KV_KEYS.last_seen_at,
        );
      } else {
        void this.refreshActivityIfDue(pubkeys).catch((error) => {
          logger.warn(
            "Background activity scan failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }

      // Array#sort is stable, so equally unknown pubkeys keep their graph order.
      return [...pubkeys].sort(
        (a, b) => Number(lastSeen.get(b) ?? 0) - Number(lastSeen.get(a) ?? 0),
      );
    } catch (error) {
      logger.warn(
        "Activity ordering failed; validating in graph order:",
        error instanceof Error ? error.message : String(error),
      );
      return pubkeys;
    }
  }

  /**
   * Records when each pubkey was last seen publishing, at most once per sync interval. Concurrent
   * callers share the scan that is already in flight.
   */
  private refreshActivityIfDue(pubkeys: string[]): Promise<void> {
    this.activityScan ??= this.scanActivityIfDue(pubkeys).finally(() => {
      this.activityScan = null;
    });
    return this.activityScan;
  }

  private async scanActivityIfDue(pubkeys: string[]): Promise<void> {
    const lastRun = Number(
      await this.settingsRepository.get(ACTIVITY_SCAN_SETTINGS_KEY),
    );
    if (nowMs() - lastRun < this.config.syncIntervalHours * 3600 * 1000) {
      return;
    }

    const startedAt = nowMs();
    const lastSeen = await fetchLastSeenAt(
      this.pool,
      this.config.nostrRelays,
      pubkeys,
      nowSeconds() - ACTIVITY_WINDOW_SECONDS,
    );
    await this.pubkeyKvRepository!.setMany(
      PUBKEY_KV_KEYS.last_seen_at,
      new Map(
        Array.from(lastSeen, ([pubkey, seenAt]) => [pubkey, String(seenAt)]),
      ),
    );
    await this.settingsRepository.set(
      ACTIVITY_SCAN_SETTINGS_KEY,
      String(nowMs()),
    );

    logger.info(
      `🕐 Activity scan: ${lastSeen.size.toLocaleString()} of ${pubkeys.length.toLocaleString()} pubkeys published in the last 30 days (${nowMs() - startedAt}ms)`,
    );
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
