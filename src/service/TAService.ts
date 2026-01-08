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

export type ManageTASubAction = "get" | "subscribe" | "unsubscribe";

export interface ManageTASubResult {
  success: boolean;
  message?: string;
  subscriberPubkey: string;

  /**
   * Whether the subscriber is currently active (i.e. the server is publishing TA events for them).
   */
  isActive: boolean;

  /**
   * Stable timestamps from the DB when available.
   * - createdAt: when the subscriber record was first created
   * - updatedAt: last state change (subscribe/unsubscribe) or latest rank update
   */
  createdAt: number | null;
  updatedAt: number | null;

  /**
   * Only included for subscribe, when we compute & publish a TA rank.
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
   * Manage TA subscription state for a given pubkey.
   *
   * - "get": returns the current subscription state
   * - "subscribe": activates the subscription and publishes a (replaceable) TA event
   * - "unsubscribe": deactivates the subscription
   */
  async manageTASub(
    action: ManageTASubAction,
    subscriberPubkey: string,
    customRelays?: string[],
  ): Promise<ManageTASubResult> {
    if (action === "get") {
      const subscriber =
        await this.taRepository.getSubscriber(subscriberPubkey);

      const result: ManageTASubResult = {
        success: true,
        subscriberPubkey,
        isActive: Boolean(subscriber?.isActive),
        createdAt: subscriber?.createdAt ?? null,
        updatedAt: subscriber?.updatedAt ?? null,
      };

      // Include rank if subscriber exists and has a latestRank
      if (subscriber && subscriber.latestRank !== null) {
        result.rank = {
          published: subscriber.isActive,
          rank: subscriber.latestRank,
          previousRank: subscriber.latestRank,
        };
      }

      return result;
    }

    if (action === "subscribe") {
      // First compute and publish (atomic - no DB changes yet)
      const rank = await this.computeAndPublishRank(
        subscriberPubkey,
        customRelays,
      );

      // Only if publishing succeeds, add to DB
      const subscriber =
        await this.taRepository.addSubscriber(subscriberPubkey);

      // Persist the computed rank immediately
      await this.taRepository.updateLatestRank(
        subscriberPubkey,
        rank.rank,
        Math.floor(Date.now() / 1000),
      );

      return {
        success: true,
        subscriberPubkey,
        isActive: true,
        createdAt: subscriber.createdAt,
        updatedAt: subscriber.updatedAt,
        rank,
      };
    }

    // action === "unsubscribe"
    await this.taRepository.deactivateSubscriber(subscriberPubkey);
    // TODO: Maybe we can remove this reading operation.
    const subscriber = await this.taRepository.getSubscriber(subscriberPubkey);
    const now = Math.floor(Date.now() / 1000);
    logger.debug(`TA subscription deactivated for ${subscriberPubkey}`);
    return {
      success: true,
      subscriberPubkey,
      isActive: false,
      createdAt: subscriber?.createdAt ?? null,
      updatedAt: subscriber?.updatedAt ?? now,
    };
  }

  /**
   * Publish Kind 30382 TA event for a subscriber
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

      // Combine user's relays with server relays and custom relays (deduplicated)
      const allRelays = relaySet([
        ...userRelays,
        ...this.config.serverRelays,
        ...(customRelays || []),
      ]);

      // Persist combined TA relay list to pubkey_kv for future use
      if (allRelays.length > 0) {
        const taRelaysValue: TARelaysValueV1 = {
          version: 1,
          relays: Array.from(allRelays),
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
        created_at: Math.floor(Date.now() / 1000),
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
   * Compute rank for a subscriber and publish
   * This is called after syncs to update TA events
   * @param subscriberPubkey Subscriber's public key
   * @returns Object indicating if event was published and the rank
   */
  async computeAndPublishRank(
    subscriberPubkey: string,
    customRelays?: string[],
  ): Promise<TARankUpdateResult> {
    // Get current subscriber data (if exists)
    const subscriber = await this.taRepository.getSubscriber(subscriberPubkey);

    // Compute new rank using existing trust calculation
    const trustScore = await this.relatrService.calculateTrustScore({
      targetPubkey: subscriberPubkey,
    });

    // Convert trust score (0-1) to rank (0-100)
    const newRank = Math.round(trustScore.score * 100);

    // Check if rank has changed (null for new subscribers)
    const previousRank = subscriber?.latestRank ?? null;

    // Publish TA event (let errors propagate)
    const relayResults = await this.publishTAEvent(
      subscriberPubkey,
      newRank,
      customRelays,
    );

    // Only update DB if subscriber exists and rank changed
    if (subscriber && previousRank !== newRank) {
      await this.taRepository.updateLatestRank(
        subscriberPubkey,
        newRank,
        Math.floor(Date.now() / 1000),
      );
      logger.info(
        `TA rank updated for ${subscriberPubkey}: ${previousRank} → ${newRank}`,
      );
    } else if (previousRank === newRank) {
      logger.debug(`TA rank unchanged for ${subscriberPubkey}: ${newRank}`);
    }

    return {
      published: true,
      rank: newRank,
      previousRank,
      relayResults,
    };
  }

  /**
   * Get TA service statistics
   */
  getStats(): ReturnType<TARepository["getStats"]> {
    return this.taRepository.getStats();
  }

  /**
   * Update ranks for all active subscribers
   * This should be called after social graph syncs
   */
  async updateAllSubscriberRanks(): Promise<void> {
    try {
      const activeSubscribers = await this.taRepository.getActiveSubscribers();
      logger.info(
        `Updating TA ranks for ${activeSubscribers.length} active subscribers`,
      );

      // Process each subscriber asynchronously
      const updatePromises = activeSubscribers.map(async (subscriberPubkey) => {
        try {
          await this.computeAndPublishRank(subscriberPubkey);
        } catch (error) {
          logger.error(
            `Failed to update TA rank for ${subscriberPubkey}:`,
            error instanceof Error ? error.message : String(error),
          );
          // Continue with other subscribers even if one fails
        }
      });

      await Promise.allSettled(updatePromises);
      logger.info("TA rank updates completed for all active subscribers");
    } catch (error) {
      logger.error(
        "Failed to update TA ranks for all subscribers:",
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `Bulk TA rank update failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_BULK_UPDATE_FAILED",
      );
    }
  }
}
