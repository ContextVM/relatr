import { RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import type { NostrProfile } from "@/types";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import { logger } from "@/utils/Logger";

/**
 * Parameters for metadata fetching
 */
export interface MetadataFetchParams {
  pubkeys: string[];
  sourcePubkey?: string;
}

/**
 * Result of metadata fetching
 */
export interface MetadataFetchResult {
  success: boolean;
  message: string;
  profilesFetched: number;
}

/**
 * Fetcher class responsible for fetching and caching pubkey metadata
 * Separates the concerns of metadata fetching from the main service
 */
export class PubkeyMetadataFetcher {
  private pool: RelayPool;
  private eventStore?: EventStore;
  private metadataRepository: MetadataRepository;

  constructor(
    pool: RelayPool,
    metadataRepository: MetadataRepository,
    eventStore?: EventStore,
  ) {
    this.pool = pool;
    this.eventStore = eventStore;
    this.metadataRepository = metadataRepository;
  }

  /**
   * Fetches and caches profile metadata for a list of pubkeys
   * @param params Parameters for metadata fetching including pubkeys and optional source pubkey
   * @returns Result of the metadata fetching process
   */
  async fetchMetadata(
    params: MetadataFetchParams,
  ): Promise<MetadataFetchResult> {
    const { pubkeys } = params;

    if (pubkeys.length === 0) {
      return {
        success: true,
        message: "No pubkeys provided for metadata fetching.",
        profilesFetched: 0,
      };
    }

    logger.info(
      `👤 Starting metadata fetch for ${pubkeys.length.toLocaleString()} pubkeys...`,
    );

    try {
      const profileEvents = await fetchEventsForPubkeys(
        pubkeys,
        0,
        undefined,
        this.pool,
        this.eventStore,
      );

      if (profileEvents.length === 0) {
        logger.warn("⚠️ No profile events found.");
        return {
          success: true,
          message: "No profile events found.",
          profilesFetched: 0,
        };
      }

      // Cache the metadata
      await this.storeProfileMetadata(profileEvents);

      const message = `Fetched and cached metadata for ${profileEvents.length} profiles.`;
      logger.info(`✅ ${message}`);

      return {
        success: true,
        message,
        profilesFetched: profileEvents.length,
      };
    } catch (error) {
      throw new Error(
        `Metadata fetching failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Cache profile metadata from kind 0 events
   * @param events Profile events to cache
   */
  private async storeProfileMetadata(events: NostrEvent[]): Promise<void> {
    for (const event of events) {
      try {
        if (!event.content) continue;
        const content = JSON.parse(event.content);
        const profile = { ...content, pubkey: event.pubkey };
        await this.metadataRepository.save(profile);
      } catch (e) {
        logger.warn(`Failed to save profile for ${event.pubkey}:`, e);
      }
    }
  }
}
