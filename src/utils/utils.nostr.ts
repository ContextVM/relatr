import { EventStore } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { RelatrError } from "../types";
import type { RelayPool } from "applesauce-relay";
import { SQLiteError } from "bun:sqlite";
import { decode, npubEncode, nprofileEncode } from "nostr-tools/nip19";

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
  console.debug(
    `[Utils] 📡 Fetching events from ${relays.join(", ")} - Kind: ${filter.kinds?.join(", ")}, Authors: ${filter.authors?.length || 0}`,
  );

  const eventsObservable = pool.sync(relays, eventStore, filter);

  try {
    // If an AbortSignal is provided, subscribe manually so we can unsubscribe on abort.
    return await new Promise<NostrEvent[]>((resolve) => {
      const collected: NostrEvent[] = [];
      const sub = eventsObservable.subscribe({
        next: (evt) => {
          // The event should already be in the event store due to the sync call
          // But let's explicitly add it to ensure it's stored
          try {
            eventStore.add(evt);
          } catch (error) {
            if (error instanceof SQLiteError) {
              console.warn(
                `[Utils] ⚠️ Failed to add event to event store:`,
                error.message,
                "Skipping...",
              );
            }
          }
          collected.push(evt);
        },
        error: (err) => {
          console.warn(
            `[Utils] ⚠️ Stream error from ${relays.join(", ")}:`,
            err,
          );
          resolve([]);
        },
        complete: () => resolve(collected),
      });

      if (signal.aborted) {
        sub.unsubscribe();
        resolve([]);
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          console.warn(`[Utils] 🛑 Request aborted for ${relays.join(", ")}`);
          try {
            sub.unsubscribe();
          } catch (_) {}
          resolve([]);
        },
        { once: true },
      );
    });
  } catch (error) {
    console.warn(`[Utils] ❌ Request failed for ${relays.join(", ")}:`, error);
    return [];
  }
}

/**
 * Fetch events for a list of pubkeys from relays
 * @param pubkeys List of pubkeys to fetch events for
 * @param kind The event kind to fetch
 * @param relays Relays to query (optional)
 * @returns Array of Nostr events
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
  eventStore?: EventStore,
): Promise<NostrEvent[]> {
  const allEvents: NostrEvent[] = [];

  for (let i = 0; i < pubkeys.length; i += 500) {
    console.log(
      `[Utils] 📥 Fetching kind ${kind} events: batch ${Math.floor(i / 500) + 1}/${Math.ceil(pubkeys.length / 500)} (${i + 1}-${Math.min(i + 500, pubkeys.length)} of ${pubkeys.length} pubkeys)`,
    );
    const batch = pubkeys.slice(i, i + 500);

    const controller = new AbortController();
    const signal = controller.signal;
    const BATCH_TIMEOUT_MS = 30000;

    const timer = setTimeout(() => {
      controller.abort();
    }, BATCH_TIMEOUT_MS);

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
        eventStore || new EventStore(),
      );
    } finally {
      clearTimeout(timer);
    }

    allEvents.push(...events);
  }

  return allEvents;
}

/**
 * Validates if a string is a valid hex key (32 bytes = 64 hex characters)
 * @param value The string to validate
 * @returns True if valid hex key, false otherwise
 */
export function isHexKey(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return /^[0-9a-fA-F]{64}$/.test(value);
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
    return null;
  }

  return null;
}

/**
 * Encodes a hex pubkey to npub format
 * @param hexPubkey The hex pubkey to encode
 * @returns The npub encoded string
 */
export function encodeNpub(hexPubkey: string): string {
  return npubEncode(hexPubkey);
}

/**
 * Encodes a hex pubkey and optional relays to nprofile format
 * @param hexPubkey The hex pubkey to encode
 * @param relays Optional array of relay URLs
 * @returns The nprofile encoded string
 */
export function encodeNprofile(hexPubkey: string, relays?: string[]): string {
  return nprofileEncode({ pubkey: hexPubkey, relays: relays || [] });
}

/**
 * Type guard functions for nostr identifiers
 */
export const NostrIdentifierTypeGuard = {
  isNpub: (value: string): boolean => {
    if (!value) return false;
    try {
      const { type } = decode(value);
      return type === "npub";
    } catch {
      return false;
    }
  },

  isNprofile: (value: string): boolean => {
    if (!value) return false;
    try {
      const { type } = decode(value);
      return type === "nprofile";
    } catch {
      return false;
    }
  },

  isHexPubkey: (value: string): boolean => {
    return isHexKey(value);
  },

  isValidPubkeyIdentifier: (value: string): boolean => {
    return validateAndDecodePubkey(value) !== null;
  },
};
