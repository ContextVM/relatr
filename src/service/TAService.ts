import { type UnsignedEvent } from "nostr-tools/pure";
import type { RelayPool } from "applesauce-relay";
import type { PrivateKeySigner } from "@contextvm/sdk";
import type { RelatrConfig, TARankUpdateResult } from "../types";
import { RelatrError } from "../types";
import type { TARepository } from "../database/repositories/TARepository";
import type { RelatrService } from "./RelatrService";
import { logger } from "../utils/Logger";

export interface TAServiceDependencies {
  config: RelatrConfig;
  taRepository: TARepository;
  relatrService: RelatrService;
  relayPool: RelayPool;
  signer: PrivateKeySigner;
}

export type ManageTASubAction = "get" | "subscribe" | "unsubscribe";

export interface ManageTASubResult {
  success: boolean;
  message: string;
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
  private relatrService: RelatrService;
  private relayPool: RelayPool;
  private signer: PrivateKeySigner;

  constructor(dependencies: TAServiceDependencies) {
    this.config = dependencies.config;
    this.taRepository = dependencies.taRepository;
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
  ): Promise<ManageTASubResult> {
    try {
      if (action === "get") {
        const subscriber =
          await this.taRepository.getSubscriber(subscriberPubkey);

        return {
          success: true,
          message: subscriber?.isActive
            ? "TA subscription is active"
            : "TA subscription is inactive",
          subscriberPubkey,
          isActive: Boolean(subscriber?.isActive),
          createdAt: subscriber?.createdAt ?? null,
          updatedAt: subscriber?.updatedAt ?? null,
        };
      }

      if (action === "subscribe") {
        // Upsert & activate (idempotent)
        const subscriber =
          await this.taRepository.addSubscriber(subscriberPubkey);

        // Publish a replaceable TA event on every subscribe call
        const rank = await this.computeAndPublishRank(subscriberPubkey);

        return {
          success: true,
          message: "TA subscription activated",
          subscriberPubkey,
          isActive: true,
          createdAt: subscriber.createdAt,
          updatedAt: subscriber.updatedAt,
          rank,
        };
      }

      // action === "unsubscribe"
      await this.taRepository.deactivateSubscriber(subscriberPubkey);

      const subscriber =
        await this.taRepository.getSubscriber(subscriberPubkey);
      const now = Math.floor(Date.now() / 1000);

      return {
        success: true,
        message: "TA subscription deactivated",
        subscriberPubkey,
        isActive: false,
        createdAt: subscriber?.createdAt ?? null,
        updatedAt: subscriber?.updatedAt ?? now,
      };
    } catch (error) {
      logger.error(
        `Failed to manage TA subscription (action=${action}) for ${subscriberPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );

      throw new RelatrError(
        `TA subscription management failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_SUBSCRIPTION_MANAGEMENT_FAILED",
      );
    }
  }

  /**
   * Publish Kind 30382 TA event for a subscriber
   * @param subscriberPubkey Subscriber's public key
   * @param targetPubkey Target pubkey to rank
   * @param rank Computed rank value (0-100)
   * @returns Event ID of published event
   */
  async publishTAEvent(targetPubkey: string, rank: number): Promise<string> {
    try {
      // Create Kind 30382 event following NIP-85
      const unsignedEvent: UnsignedEvent = {
        kind: 30382,
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

      // Publish to configured relays
      await this.relayPool.publish(this.config.serverRelays, signedEvent);

      logger.info(`Published TA event for ${targetPubkey}, rank ${rank}`);

      return signedEvent.id;
    } catch (error) {
      logger.error(
        `Failed to publish TA event for ${targetPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `TA event publishing failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_PUBLISH_FAILED",
      );
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
  ): Promise<TARankUpdateResult> {
    try {
      // Get current subscriber data
      const subscriber =
        await this.taRepository.getSubscriber(subscriberPubkey);
      if (!subscriber) {
        throw new RelatrError(
          "Subscriber not found",
          "TA_SUBSCRIBER_NOT_FOUND",
        );
      }

      // Compute new rank using existing trust calculation
      const trustScore = await this.relatrService.calculateTrustScore({
        targetPubkey: subscriberPubkey,
      });

      // Convert trust score (0-1) to rank (0-100)
      const newRank = Math.round(trustScore.score * 100);

      // Check if rank has changed
      const previousRank = subscriber.latestRank;
      // Publish TA event
      await this.publishTAEvent(subscriberPubkey, newRank);
      if (previousRank !== null && previousRank === newRank) {
        logger.debug(`TA rank unchanged for ${subscriberPubkey}: ${newRank}`);
        return {
          published: true,
          rank: newRank,
          previousRank,
        };
      } else {
        // Update stored rank
        await this.taRepository.updateLatestRank(
          subscriberPubkey,
          newRank,
          Math.floor(Date.now() / 1000),
        );
      }

      logger.info(
        `TA rank updated for ${subscriberPubkey}: ${previousRank} → ${newRank}`,
      );

      return {
        published: true,
        rank: newRank,
        previousRank,
      };
    } catch (error) {
      logger.error(
        `Failed to compute and publish TA rank for ${subscriberPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `TA rank computation failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_RANK_COMPUTATION_FAILED",
      );
    }
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
