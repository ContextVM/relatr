import { RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import type { NostrProfile } from "@/types";
import type { DataStore } from "@/database/data-store";

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
  private metadataCache: DataStore<NostrProfile>;

  constructor(
    pool: RelayPool,
    metadataCache: DataStore<NostrProfile>,
    eventStore?: EventStore,
  ) {
    this.pool = pool;
    this.eventStore = eventStore;
    this.metadataCache = metadataCache;
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

    console.log(
      `[PubkeyMetadataFetcher] 👤 Starting metadata fetch for ${pubkeys.length.toLocaleString()} pubkeys...`,
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
        console.warn("[PubkeyMetadataFetcher] ⚠️ No profile events found.");
        return {
          success: true,
          message: "No profile events found.",
          profilesFetched: 0,
        };
      }

      // Cache the metadata using batch operations
      await this.storeProfileMetadata(profileEvents);

      const message = `Fetched and cached metadata for ${profileEvents.length} profiles.`;
      console.log(`[PubkeyMetadataFetcher] ✅ ${message}`);

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
  // TODO: We dont need all this unneceary object creation
  private async storeProfileMetadata(events: NostrEvent[]): Promise<void> {
    const entries = [];
    for (const event of events) {
      try {
        const profile = JSON.parse(event.content);
        entries.push({
          key: event.pubkey,
          value: {
            pubkey: event.pubkey,
            name: profile.name,
            display_name: profile.display_name,
            nip05: profile.nip05,
            lud16: profile.lud16,
            about: profile.about,
          },
        });
      } catch (e) {
        // ignore invalid profile
      }
    }

    if (entries.length > 0) {
      await this.metadataCache.batchSet(entries);
    }
  }
}
