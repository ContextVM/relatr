import { EventStore } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { RelatrError } from "../types";
import type { RelayPool } from "applesauce-relay";
import { decode } from "nostr-tools/nip19";
import { logger } from "./Logger";
import { isHexKey } from "applesauce-core/helpers";

/**
 * Default batch size for fetching events from relays
 */
const DEFAULT_BATCH_SIZE = 500;

export async function negSyncFromRelays(
  pool: RelayPool | null,
  relays: string[],
  filter: Filter,
  signal: AbortSignal,
  eventStore: EventStore,
): Promise<NostrEvent[]> {
  if (!pool) {
    throw new RelatrError("Relay pool not initialized", "NOT_INITIALIZED");
  }
  logger.debug(
    `📡 Fetching events from ${relays.join(", ")} - Kind: ${filter.kinds?.join(", ")}, Authors: ${filter.authors?.length || 0}`,
  );

  const eventsObservable = pool.sync(relays, eventStore, filter);

  try {
    // If an AbortSignal is provided, subscribe manually so we can unsubscribe on abort.
    return await new Promise<NostrEvent[]>((resolve) => {
      const sub = eventsObservable.subscribe({
        next: (evt) => {
          // The event should already be in the event store due to the sync call
          // But let's explicitly add it to ensure it's stored
          try {
            eventStore.add(evt);
          } catch (error) {
            logger.warn(
              `⚠️ Failed to add event to event store:`,
              error instanceof Error ? error.message : String(error),
              "Skipping...",
            );
          }
        },
        error: (err) => {
          logger.warn(`⚠️ Stream error from ${relays.join(", ")}:`, err);
          resolve([]);
        },
        complete: () => {
          // Query events from the event store to return them
          const events = eventStore.getByFilters(filter);
          resolve(events);
        },
      });

      if (signal.aborted) {
        sub.unsubscribe();
        resolve([]);
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          logger.warn(`🛑 Request aborted for ${relays.join(", ")}`);
          try {
            sub.unsubscribe();
          } catch {
            // Ignore validation errors for invalid pubkeys
          }
          resolve([]);
        },
        { once: true },
      );
    });
  } catch (error) {
    logger.warn(`❌ Request failed for ${relays.join(", ")}:`, error);
    return [];
  }
}

/**
 * Fetch events for a list of pubkeys from relays with streaming support to avoid memory accumulation.
 * Note: This function clears the EventStore for the fetched authors after each batch to free memory.
 *
 * @param pubkeys List of pubkeys to fetch events for
 * @param kind The event kind to fetch
 * @param relays Relays to query (optional)
 * @param pool Relay pool instance
 * @param eventStore Event store instance (optional, creates a temporary one if not provided)
 * @param options Configuration options including batch processing callback and batch size
 * @returns Array of Nostr events if accumulate is true, otherwise empty array
 */
export async function fetchEventsForPubkeys(
  pubkeys: string[],
  kind: number,
  relays: string[] = [
    "wss://relay.damus.io",
    "wss://profiles.nostr1.com/",
    "wss://wot.grapevine.network/",
  ],
  pool: RelayPool,
  options?: {
    onBatch?: (
      events: NostrEvent[],
      batchIndex: number,
      totalBatches: number,
    ) => Promise<void> | void;
    accumulate?: boolean;
    batchSize?: number;
  },
): Promise<NostrEvent[]> {
  const { onBatch, batchSize = DEFAULT_BATCH_SIZE } = options || {};

  const totalBatches = Math.ceil(pubkeys.length / batchSize);

  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const batchIndex = Math.floor(i / batchSize) + 1;
    logger.info(
      `📥 Fetching kind ${kind} events: batch ${batchIndex}/${totalBatches} (${i + 1}-${Math.min(i + batchSize, pubkeys.length)} of ${pubkeys.length} pubkeys)`,
    );
    const batch = pubkeys.slice(i, i + batchSize);

    const controller = new AbortController();
    const signal = controller.signal;
    const BATCH_TIMEOUT_MS = 30000;

    const timer = setTimeout(() => {
      controller.abort();
    }, BATCH_TIMEOUT_MS);

    // Create a new EventStore for each batch to allow garbage collection
    const batchEventStore = new EventStore();
    let events: NostrEvent[] = [];

    try {
      events = await negSyncFromRelays(
        pool,
        relays,
        {
          kinds: [kind],
          authors: batch,
        },
        signal,
        batchEventStore,
      );

      // Process batch immediately if callback provided
      if (onBatch) {
        await onBatch(events, batchIndex, totalBatches);
      }
    } finally {
      clearTimeout(timer);
      batchEventStore.removeByFilters({
        kinds: [kind],
        authors: batch,
      });
    }
  }

  return [];
}

/**
 * Validates and decodes a nostr identifier (hex pubkey, npub, or nprofile)
 * @param identifier The identifier to validate and decode
 * @returns The hex pubkey if valid, null otherwise
 */
export function validateAndDecodePubkey(identifier: string): string | null {
  if (!identifier) return null;

  // Check if it's a hex pubkey
  if (isHexKey(identifier)) {
    return identifier.toLowerCase();
  }

  try {
    // Try to decode as nip19
    const { type, data } = decode(identifier);

    if (type === "npub") {
      return data as string;
    } else if (type === "nprofile") {
      const profile = data as { pubkey: string; relays?: string[] };
      return profile.pubkey;
    }
  } catch (error) {
    // Invalid nip19 format
    logger.warn(
      `[Utils] ⚠️ Invalid nip19 identifier: ${identifier}`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }

  return null;
}

/**
 * Fetch a user's relay list (kind 10002) from relays
 * @param pubkey User's public key
 * @param pool Relay pool
 * @param relays Relays to query
 * @param timeoutMs Timeout in milliseconds (default: 10000)
 * @returns Array of relay URLs or null if not found
 */
export async function fetchUserRelayList(
  pubkey: string,
  pool: RelayPool,
  relays: string[],
  timeoutMs: number = 10000,
): Promise<string[] | null> {
  try {
    const event = await new Promise<NostrEvent | null>((resolve, reject) => {
      const subscription = pool
        .request(
          relays,
          {
            kinds: [10002],
            authors: [pubkey],
            limit: 1,
          },
          {
            retries: 1,
          },
        )
        .subscribe({
          next: (event) => {
            resolve(event);
            subscription.unsubscribe();
          },
          error: (error) => {
            reject(error);
          },
        });

      // Auto-unsubscribe after timeout
      setTimeout(() => {
        subscription.unsubscribe();
        resolve(null);
      }, timeoutMs);
    });

    if (!event) {
      return null;
    }

    // Extract relay URLs from event tags
    const relayUrls = event.tags
      .filter((tag) => tag[0] === "r" && tag[1])
      .map((tag) => tag[1] as string);

    return relayUrls.length > 0 ? relayUrls : null;
  } catch (error) {
    logger.warn(
      `Failed to fetch relay list for ${pubkey}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
