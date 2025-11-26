import { RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import { logger } from "@/utils/Logger";
import { z } from "zod";
import type { NostrProfile } from "@/types";

/**
 * Zod schema for Nostr profile metadata validation
 * Ensures all fields are valid strings for database insertion
 */
const NostrProfileSchema = z
  .object({
    name: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
    display_name: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
    nip05: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
    lud16: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
    about: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
    picture: z
      .string()
      .optional()
      .nullable()
      .transform((val) => val || undefined),
  })
  .passthrough();

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
  private metadataRepository: MetadataRepository;

  constructor(pool: RelayPool, metadataRepository: MetadataRepository) {
    this.pool = pool;
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

    let totalProfilesFetched = 0;

    try {
      // Fetch profile metadata with streaming to avoid memory accumulation
      // Events are processed immediately via onBatch callback and stored in database,
      // preventing O(n) memory scaling with network size.
      await fetchEventsForPubkeys(pubkeys, 0, undefined, this.pool, {
        onBatch: async (events, batchIndex, totalBatches) => {
          if (events.length === 0) return;

          const batchProfilesFetched = await this.processAndStoreBatch(events);
          totalProfilesFetched += batchProfilesFetched;

          logger.debug(
            `✅ Processed batch ${batchIndex}/${totalBatches}: ${batchProfilesFetched} profiles (total: ${totalProfilesFetched})`,
          );
        },
      });

      if (totalProfilesFetched === 0) {
        logger.warn("⚠️ No profile events found.");
        return {
          success: true,
          message: "No profile events found.",
          profilesFetched: 0,
        };
      }

      const message = `Fetched and cached metadata for ${totalProfilesFetched} profiles.`;
      logger.info(`✅ ${message}`);

      return {
        success: true,
        message,
        profilesFetched: totalProfilesFetched,
      };
    } catch (error) {
      throw new Error(
        `Metadata fetching failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Process and store a batch of profile events
   * @param events Batch of profile events to process
   * @returns Number of profiles successfully processed and stored
   */
  private async processAndStoreBatch(events: NostrEvent[]): Promise<number> {
    const BATCH_SIZE = 250;
    let profilesStored = 0;

    // Deduplicate events by pubkey, keeping the latest event for each pubkey
    const eventsByPubkey = new Map<string, NostrEvent>();
    for (const event of events) {
      const existing = eventsByPubkey.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        eventsByPubkey.set(event.pubkey, event);
      }
    }

    // Process events in smaller batches to avoid memory accumulation
    const eventArray = Array.from(eventsByPubkey.values());

    for (let i = 0; i < eventArray.length; i += BATCH_SIZE) {
      const batchEvents = eventArray.slice(i, i + BATCH_SIZE);
      const batchProfiles: NostrProfile[] = [];

      // Process validation for this batch (CPU intensive)
      for (const event of batchEvents) {
        try {
          if (!event.content) continue;

          const content = JSON.parse(event.content);
          const profile = this.validateAndSanitizeProfile(
            content,
            event.pubkey,
          );
          batchProfiles.push(profile);
        } catch (e) {
          logger.warn(`Failed to parse profile for ${event.pubkey}:`, e);
          // Create a minimal safe profile even if parsing fails
          batchProfiles.push({
            pubkey: event.pubkey,
            name: undefined,
            display_name: undefined,
            nip05: undefined,
            lud16: undefined,
            about: undefined,
          });
        }
      }

      // Save this batch to database (I/O intensive)
      if (batchProfiles.length > 0) {
        try {
          await this.metadataRepository.saveMany(batchProfiles);
          profilesStored += batchProfiles.length;
          logger.debug(
            `✅ Saved batch of ${batchProfiles.length} profiles (${i + batchProfiles.length}/${eventArray.length})`,
          );
        } catch (e) {
          logger.warn(
            `Failed to save batch of ${batchProfiles.length} profiles:`,
            e,
          );
          // Fall back to individual saves for this batch
          const individualSuccessCount =
            await this.saveProfilesIndividually(batchProfiles);
          profilesStored += individualSuccessCount;
        }
      }

      // Clear the batchProfiles array to free memory immediately
      batchProfiles.length = 0;
    }

    return profilesStored;
  }

  /**
   * Validate and sanitize profile data using Zod schema
   * Ensures all fields are valid for database insertion
   */
  private validateAndSanitizeProfile(
    content: unknown,
    pubkey: string,
  ): NostrProfile {
    try {
      // Parse with Zod schema to validate and transform the data
      const validated = NostrProfileSchema.parse(content);

      // Create the profile object with only the fields we want to store
      const profile: NostrProfile = {
        pubkey,
        name: validated.name,
        display_name: validated.display_name,
        nip05: validated.nip05,
        lud16: validated.lud16,
        about: validated.about,
        // Note: picture field is validated but not stored in DB
      };

      return profile;
    } catch (error) {
      // If Zod validation fails, create a minimal safe profile
      logger.debug(
        `Zod validation failed for ${pubkey}, creating minimal profile`,
        error,
      );

      // Return a minimal safe profile with pubkey only
      return {
        pubkey,
        name: undefined,
        display_name: undefined,
        nip05: undefined,
        lud16: undefined,
        about: undefined,
      };
    }
  }

  /**
   * Fallback method to save profiles individually if batch save fails
   * @returns Number of successfully saved profiles
   */
  private async saveProfilesIndividually(
    profiles: NostrProfile[],
  ): Promise<number> {
    let successCount = 0;
    for (const profile of profiles) {
      try {
        await this.metadataRepository.save(profile);
        successCount++;
      } catch (e) {
        logger.warn(
          `Failed to save individual profile for ${profile.pubkey}:`,
          e,
        );
      }
    }
    return successCount;
  }
}
