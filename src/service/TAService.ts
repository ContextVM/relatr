import { type UnsignedEvent } from "nostr-tools/pure";
import type { RelayPool } from "applesauce-relay";
import type { PrivateKeySigner } from "@contextvm/sdk";
import type { RelatrConfig } from "../types";
import type { TARepository } from "../database/repositories/TARepository";
import type { RelatrService } from "./RelatrService";
import { logger } from "../utils/Logger";
import { RelatrError } from "../types";

export interface TAServiceDependencies {
  config: RelatrConfig;
  taRepository: TARepository;
  relatrService: RelatrService;
  relayPool: RelayPool;
  signer: PrivateKeySigner;
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
   * Register a client as a TA subscriber
   * @param subscriberPubkey Hex-encoded public key of subscriber
   * @returns Success message with subscription details
   * @throws RelatrError if registration fails
   */
  async registerSubscriber(subscriberPubkey: string): Promise<{
    success: boolean;
    message: string;
    subscriberPubkey: string;
    createdAt: number;
  }> {
    try {
      // Check if already subscribed
      const isSubscribed =
        await this.taRepository.isSubscribed(subscriberPubkey);
      if (isSubscribed) {
        return {
          success: true,
          message: "Already registered as TA provider",
          subscriberPubkey,
          createdAt: Math.floor(Date.now() / 1000),
        };
      }

      // Add subscriber
      const subscriber =
        await this.taRepository.addSubscriber(subscriberPubkey);

      // Compute and publish initial rank
      const rankResult =
        await this.computeAndPublishRankIfChanged(subscriberPubkey);

      return {
        success: true,
        message: rankResult.published
          ? "Successfully registered and published initial TA event"
          : "Successfully registered as TA provider",
        subscriberPubkey,
        createdAt: subscriber.createdAt,
      };
    } catch (error) {
      logger.error(
        `Failed to register TA subscriber ${subscriberPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `TA registration failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_REGISTRATION_FAILED",
      );
    }
  }

  /**
   * Check if a pubkey is subscribed
   * @param subscriberPubkey Hex-encoded public key
   * @returns Boolean indicating subscription status
   */
  async isSubscribed(subscriberPubkey: string): Promise<boolean> {
    return this.taRepository.isSubscribed(subscriberPubkey);
  }

  /**
   * Publish Kind 30382 TA event for a subscriber
   * @param subscriberPubkey Subscriber's public key
   * @param targetPubkey Target pubkey to rank
   * @param rank Computed rank value (0-100)
   * @returns Event ID of published event
   */
  async publishTAEvent(
    subscriberPubkey: string,
    targetPubkey: string,
    rank: number,
  ): Promise<string> {
    try {
      // Get relay hints for the target (if available)
      const relayHint = this.config.serverRelays[0]; // Primary relay

      // Create Kind 30382 event following NIP-85
      const unsignedEvent: UnsignedEvent = {
        kind: 30382,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["d", targetPubkey], // d-tag points to the subject
          ["p", targetPubkey, relayHint ?? ""], // p-tag with relay hint
          ["rank", rank.toString()], // rank value as string
        ],
        content: "", // Empty content as per spec
        pubkey: await this.signer.getPublicKey(), // Server's pubkey
      };

      // Sign the event
      const signedEvent = await this.signer.signEvent(unsignedEvent);

      // Publish to configured relays
      await this.relayPool.publish(this.config.serverRelays, signedEvent);

      logger.info(
        `Published TA event for subscriber ${subscriberPubkey}, target ${targetPubkey}, rank ${rank}`,
      );

      return signedEvent.id;
    } catch (error) {
      logger.error(
        `Failed to publish TA event for subscriber ${subscriberPubkey}:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `TA event publishing failed: ${error instanceof Error ? error.message : String(error)}`,
        "TA_PUBLISH_FAILED",
      );
    }
  }

  /**
   * Compute rank for a subscriber and publish if changed
   * This is called after syncs to update TA events
   * @param subscriberPubkey Subscriber's public key
   * @returns Object indicating if event was published and the rank
   */
  async computeAndPublishRankIfChanged(subscriberPubkey: string): Promise<{
    published: boolean;
    rank: number;
    previousRank: number | null;
  }> {
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
        weightingScheme: "default",
      });

      // Convert trust score (0-1) to rank (0-100)
      const newRank = Math.round(trustScore.score * 100);

      // Check if rank has changed
      const previousRank = subscriber.latestRank;
      if (previousRank !== null && previousRank === newRank) {
        logger.debug(`TA rank unchanged for ${subscriberPubkey}: ${newRank}`);
        return {
          published: false,
          rank: newRank,
          previousRank,
        };
      }

      // Publish new TA event
      await this.publishTAEvent(subscriberPubkey, subscriberPubkey, newRank);

      // Update stored rank
      await this.taRepository.updateLatestRank(
        subscriberPubkey,
        newRank,
        Math.floor(Date.now() / 1000),
      );

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
  async getStats(): Promise<ReturnType<typeof this.taRepository.getStats>> {
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
          await this.computeAndPublishRankIfChanged(subscriberPubkey);
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
