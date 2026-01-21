import { type UnsignedEvent } from "nostr-tools/pure";
import type { RelayPool, PublishResponse } from "applesauce-relay";
import type { PrivateKeySigner } from "@contextvm/sdk";
import type { RelatrConfig, TARankUpdateResult } from "../types";
import { RelatrError } from "../types";
import type { TARepository } from "../database/repositories/TARepository";
import type { PubkeyKvRepository } from "../database/repositories/PubkeyKvRepository";
import type { RelatrService } from "./RelatrService";
import { logger } from "../utils/Logger";
import { fetchUserRelayList } from "../utils/utils.nostr";
import { nowSeconds } from "../utils/utils";
import { MAX_PUBLISH_RELAYS } from "../constants/pubkeyKv";
import { relaySet } from "applesauce-core/helpers";
import { COMMON_RELAYS, TA_USER_KIND } from "@/constants/nostr";
import { PUBKEY_KV_KEYS, type TARelaysValueV1 } from "@/constants/pubkeyKv";

export interface TAServiceDependencies {
  config: RelatrConfig;
  taRepository: TARepository;
  pubkeyKvRepository: PubkeyKvRepository;
  relatrService: RelatrService;
  relayPool: RelayPool;
  signer: PrivateKeySigner;
}

export type ManageTASubAction = "get" | "enable" | "disable";

export interface ManageTASubResult {
  success: boolean;
  message?: string;
  pubkey: string;

  /**
   * Whether entry was user-requested (via enable).
   */
  isActive: boolean;

  /**
   * Stable timestamps from DB when available.
   * - createdAt: when the entry was first created
   * - computedAt: last time rank was computed
   */
  createdAt: number | null;
  computedAt: number | null;

  /**
   * Only included for enable, when we compute & publish a TA rank.
   * Note: published indicates whether the publish attempt succeeded.
   */
  rank?: TARankUpdateResult;
}

export class TAService {
  private config: RelatrConfig;
  private taRepository: TARepository;
  private pubkeyKvRepository: PubkeyKvRepository;
  private relatrService: RelatrService;
  private relayPool: RelayPool;
  private signer: PrivateKeySigner;

  constructor(dependencies: TAServiceDependencies) {
    this.config = dependencies.config;
    this.taRepository = dependencies.taRepository;
    this.pubkeyKvRepository = dependencies.pubkeyKvRepository;
    this.relatrService = dependencies.relatrService;
    this.relayPool = dependencies.relayPool;
    this.signer = dependencies.signer;
  }

  /**
   * Manage TA entry state for a given pubkey.
   *
   * - "get": returns current entry state with cached rank (no compute/publish)
   * - "enable": computes rank, publishes TA event, and marks entry as user-requested
   * - "disable": marks entry as not user-requested (keeps cached rank)
   */
  async manageTASub(
    action: ManageTASubAction,
    pubkey: string,
    customRelays?: string[],
  ): Promise<ManageTASubResult> {
    // Guard: TA feature must be enabled
    if (!this.config.taEnabled) {
      return {
        success: false,
        message: "TA feature is disabled",
        pubkey,
        isActive: false,
        createdAt: null,
        computedAt: null,
      };
    }
    if (action === "get") {
      const user = await this.taRepository.getTA(pubkey);

      const result: ManageTASubResult = {
        success: true,
        pubkey,
        isActive: Boolean(user?.isActive),
        createdAt: user?.createdAt ?? null,
        computedAt: user?.computedAt ?? null,
      };

      // Include rank if user exists and has a latestRank
      if (user && user.latestRank !== null) {
        result.rank = {
          published: false, // get action doesn't publish
          rank: user.latestRank,
          previousRank: user.latestRank,
        };
      }

      return result;
    }

    if (action === "enable") {
      // Get or create user entry with is_active=TRUE
      const user = await this.taRepository.getOrCreateTA(pubkey, true);

      // Compute rank first (non-atomic: persist regardless of publish success)
      // IMPORTANT: disable TA refresh to avoid triggering lazy refresh
      // (which would otherwise cause duplicate compute/publish work on enable).
      const trustScore = await this.relatrService.calculateTrustScore(
        {
          targetPubkey: pubkey,
        },
        false,
      );
      const newRank = Math.round(trustScore.score * 100);
      const now = nowSeconds();

      // Persist the computed rank immediately
      await this.taRepository.updateLatestRank(pubkey, newRank, now, {
        // getOrCreateTA() above guarantees existence
        existsGuaranteed: true,
      });

      // Publish TA event (errors are caught and logged, don't fail the operation)
      let published = false;
      let relayResults: PublishResponse[] | undefined;
      try {
        relayResults = await this.publishTAEvent(pubkey, newRank, customRelays);
        published = true;
      } catch (error) {
        logger.warn(
          `TA publish failed for ${pubkey}, but rank was cached:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      return {
        success: true,
        pubkey,
        isActive: true,
        createdAt: user.createdAt,
        computedAt: now,
        rank: {
          published,
          rank: newRank,
          previousRank: user.latestRank,
          relayResults,
        },
      };
    }

    // action === "disable"
    await this.taRepository.disableTA(pubkey);
    logger.debug(`TA entry deactivated for ${pubkey}`);
    return {
      success: true,
      pubkey,
      isActive: false,
      createdAt: null,
      computedAt: null,
    };
  }

  /**
   * Publish Kind 30382 TA event for a user
   * @param targetPubkey Target pubkey to rank
   * @param rank Computed rank value (0-100)
   * @param customRelays Optional list of custom relay URLs to publish to
   * @returns Event ID of published event and relay results
   */
  async publishTAEvent(
    targetPubkey: string,
    rank: number,
    customRelays?: string[],
  ): Promise<PublishResponse[]> {
    // Guard: TA feature must be enabled
    if (!this.config.taEnabled) {
      throw new RelatrError("TA feature is disabled", "TA_FEATURE_DISABLED");
    }

    try {
      // Try to get cached TA relays from pubkey_kv store
      let userRelays: string[] = [];
      const cachedTARelays =
        await this.pubkeyKvRepository.getJSON<TARelaysValueV1>(
          targetPubkey,
          PUBKEY_KV_KEYS.ta_relays,
        );

      if (cachedTARelays) {
        userRelays = cachedTARelays.relays;
        logger.debug(
          `Using cached TA relays for ${targetPubkey}: ${userRelays.length} relays`,
        );
      } else {
        // Fetch user's inboxes and outboxes from relays
        const fetchedRelays = await fetchUserRelayList(
          targetPubkey,
          this.relayPool,
          COMMON_RELAYS,
          this.pubkeyKvRepository,
          undefined,
          this.config.maxStoredRelays,
        );

        if (
          (fetchedRelays && fetchedRelays.inboxes?.length) ||
          fetchedRelays?.outboxes?.length
        ) {
          userRelays = relaySet(fetchedRelays.inboxes, fetchedRelays.outboxes);
        } else {
          logger.debug(
            `No relay list found for ${targetPubkey}, using server relays only`,
          );
        }
      }

      // Prioritize: user inboxes → server relays → extra relays → custom relays
      // De-duplicate and cap
      const allRelays = relaySet([
        ...userRelays,
        ...this.config.serverRelays,
        ...this.config.taExtraRelays,
        ...(customRelays || []),
      ]).slice(0, MAX_PUBLISH_RELAYS);

      // Persist combined TA relay list to pubkey_kv for future use
      if (allRelays.length > 0) {
        const taRelaysValue: TARelaysValueV1 = {
          version: 1,
          relays: allRelays,
        };
        await this.pubkeyKvRepository.setJSON(
          targetPubkey,
          PUBKEY_KV_KEYS.ta_relays,
          taRelaysValue,
        );

        logger.debug(
          `Cached TA relays for ${targetPubkey}: ${allRelays.length} relays`,
        );
      }

      // Create Kind 30382 event following NIP-85
      const unsignedEvent: UnsignedEvent = {
        kind: TA_USER_KIND,
        created_at: nowSeconds(),
        tags: [
          ["d", targetPubkey], // d-tag points to the subject
          ["rank", rank.toString()], // rank value as string
        ],
        content: "", // Empty content as per spec
        pubkey: await this.signer.getPublicKey(), // Server's pubkey
      };

      // Sign the event
      const signedEvent = await this.signer.signEvent(unsignedEvent);

      // Publish to combined relay list
      const relayResults = await this.relayPool.publish(allRelays, signedEvent);

      // Check if at least one relay accepted the event
      const atLeastOneSuccess = relayResults.some((result) => result.ok);

      if (!atLeastOneSuccess) {
        const failedRelays = relayResults
          .map(
            (result) => `${result.from}: ${result.message || "Unknown error"}`,
          )
          .join(", ");

        throw new RelatrError(
          `Failed to publish TA event to any relay. Attempted: ${failedRelays}`,
          "TA_PUBLISH_FAILED",
        );
      }

      logger.info(
        `Published TA event for ${targetPubkey}, rank ${rank} to ${allRelays.length} relays. Results: ${JSON.stringify(relayResults)}`,
      );

      return relayResults;
    } catch (error) {
      // Preserve RelatrError to avoid double-wrapping
      if (error instanceof RelatrError) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to publish TA event for ${targetPubkey}:`,
        errorMessage,
      );
      throw new RelatrError(errorMessage, "TA_PUBLISH_FAILED");
    }
  }

  /**
   * Compute rank for a user without publishing
   * Used for cache refresh
   * @param pubkey TA user public key
   * @returns The computed rank (0-100)
   */
  async computeRank(pubkey: string): Promise<number> {
    // Use calculateTrustScore with TA refresh disabled to avoid recursion
    const trustScore = await this.relatrService.calculateTrustScore(
      {
        targetPubkey: pubkey,
      },
      false,
    );
    return Math.round(trustScore.score * 100);
  }

  /**
   * Refresh stale TA ranks for active entries only
   * This recomputes ranks for stale active entries and publishes TA events only when rank changes
   * @returns Summary of refresh results
   */
  async refreshStaleRanks(): Promise<{
    staleEntries: number;
    refreshed: number;
    published: number;
    errors: number;
  }> {
    // Guard: TA feature must be enabled
    if (!this.config.taEnabled) {
      logger.debug("TA refresh skipped: feature is disabled");
      return { staleEntries: 0, refreshed: 0, published: 0, errors: 0 };
    }

    try {
      const now = nowSeconds();
      const staleThreshold = now - this.config.cacheTtlHours * 3600;

      // Use DuckDB to filter stale active TA directly
      const staleActiveTA =
        await this.taRepository.getStaleActiveTA(staleThreshold);

      logger.info(`TA refresh: ${staleActiveTA.length} stale active entries`);

      let refreshed = 0;
      let published = 0;
      let errors = 0;

      // Compute ranks for stale active TA only
      const rankUpdates: Array<{
        pubkey: string;
        rank: number;
        computedAt: number;
      }> = [];
      const publishQueue: Array<{ pubkey: string; rank: number }> = [];

      for (const user of staleActiveTA) {
        try {
          // Compute new rank
          const newRank = await this.computeRank(user.pubkey);
          const previousRank = user.latestRank;
          const changed = previousRank === null || previousRank !== newRank;

          rankUpdates.push({
            pubkey: user.pubkey,
            rank: newRank,
            computedAt: now,
          });

          // Only publish if rank changed
          if (changed) {
            publishQueue.push({
              pubkey: user.pubkey,
              rank: newRank,
            });
          }

          logger.debug(
            `TA rank computed for ${user.pubkey}: ${previousRank} → ${newRank} ${changed ? "(changed)" : "(unchanged)"}`,
          );
        } catch (error) {
          errors++;
          logger.error(
            `Failed to compute TA rank for ${user.pubkey}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // Bulk update all ranks in a single transaction
      if (rankUpdates.length > 0) {
        try {
          await this.taRepository.updateLatestRanksBatch(rankUpdates);
          refreshed = rankUpdates.length;
        } catch (error) {
          errors += rankUpdates.length;
          logger.error(
            `Failed to bulk update TA ranks:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // Publish TA events only for changed ranks
      for (const item of publishQueue) {
        try {
          await this.publishTAEvent(item.pubkey, item.rank);
          published++;
        } catch (error) {
          errors++;
          logger.error(
            `Failed to publish TA event for ${item.pubkey}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      logger.info(
        `TA refresh completed: ${refreshed} refreshed, ${published} published, ${errors} errors`,
      );

      return {
        staleEntries: staleActiveTA.length,
        refreshed,
        published,
        errors,
      };
    } catch (error) {
      logger.error(
        "Failed to refresh TA ranks:",
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `TA refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_REFRESH_FAILED",
      );
    }
  }

  /**
   * Lazy refresh and publish for inactive entries
   * Called when trust is computed for an inactive pubkey
   * This ensures cache stays warm and publishes when rank changes
   * @param targetPubkey Target pubkey to potentially refresh
   */
  async maybeRefreshAndEnqueueTA(targetPubkey: string): Promise<void> {
    // Guard: TA feature must be enabled
    if (!this.config.taEnabled) {
      return;
    }

    try {
      const user = await this.taRepository.getTA(targetPubkey);
      const now = nowSeconds();
      const staleThreshold = now - this.config.cacheTtlHours * 3600;

      const stale =
        !user || user.latestRank === null || user.computedAt < staleThreshold;

      if (!stale) {
        return; // Cache is fresh, nothing to do
      }

      // Compute new rank
      const newRank = await this.computeRank(targetPubkey);
      const previousRank = user?.latestRank ?? null;
      const changed = previousRank === null || previousRank !== newRank;

      // Get or create user entry (inactive by default for lazy refresh)
      await this.taRepository.getOrCreateTA(targetPubkey, false);

      // Update rank with existence guaranteed (hot path optimization)
      await this.taRepository.updateLatestRank(targetPubkey, newRank, now, {
        existsGuaranteed: true,
      });

      // Publish only if rank changed
      if (changed) {
        try {
          await this.publishTAEvent(targetPubkey, newRank);
          logger.debug(
            `Lazy TA refresh: published for ${targetPubkey}, rank ${previousRank} → ${newRank}`,
          );
        } catch (error) {
          logger.warn(
            `Failed to publish TA event for ${targetPubkey} during lazy refresh:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        logger.debug(
          `Lazy TA refresh: rank unchanged for ${targetPubkey}, skipping publish`,
        );
      }
    } catch (error) {
      logger.error(
        `Failed to lazy refresh TA for ${targetPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      // Don't throw - this is a best-effort cache update
    }
  }

  /**
   * Get TA service statistics
   */
  getStats(): ReturnType<TARepository["getStats"]> {
    return this.taRepository.getStats();
  }
}
