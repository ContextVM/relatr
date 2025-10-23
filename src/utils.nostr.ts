import { EventStore, lastValueFrom } from "applesauce-core";
import type { NostrEvent } from "nostr-social-graph";
import type { Filter } from "nostr-tools";
import { RelatrError } from "./types";
import type { RelayPool } from "applesauce-relay";
import { toArray, timeout, catchError } from "rxjs/operators";
import { of } from "rxjs";

export async function negSyncFromRelays(
  pool: RelayPool | null,
  relays: string[],
  filter: Filter,
  eventStore?: EventStore,
  signal?: AbortSignal,
): Promise<NostrEvent[]> {
  if (!pool) {
    throw new RelatrError("Relay pool not initialized", "NOT_INITIALIZED");
  }
  console.debug(
    `[Utils] 📡 Fetching events from ${relays.join(", ")} - Kind: ${filter.kinds?.join(", ")}, Authors: ${filter.authors?.length || 0}`,
  );

  const eventsObservable = pool.sync(
    relays,
    eventStore || new EventStore(),
    filter,
  );

  try {
    // If an AbortSignal is provided, subscribe manually so we can unsubscribe on abort.
    if (signal) {
      return await new Promise<NostrEvent[]>((resolve) => {
        const collected: NostrEvent[] = [];
        const sub = eventsObservable.subscribe({
          next: (evt) => {
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
    }

    // Backwards-compatible behavior: if no AbortSignal is provided, keep the original timeout-based approach.
    const events = await lastValueFrom(
      eventsObservable.pipe(
        toArray(),
        timeout(60000), // 60-second timeout
        catchError((err) => {
          if (err && (err as any).name === "TimeoutError") {
            console.warn(
              `[Utils] ⏰ Request timed out after 60s for ${relays.join(", ")}`,
            );
          } else {
            console.warn(
              `[Utils] ⚠️ Stream error from ${relays.join(", ")}:`,
              err,
            );
          }
          return of([]); // Return empty array on any error from the stream
        }),
      ),
    );
    return events;
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
  relays: string[] = ["wss://relay.damus.io"],
  pool: RelayPool,
  eventStore: EventStore | null = null,
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
        eventStore || undefined,
        signal,
      );
    } finally {
      clearTimeout(timer);
    }

    allEvents.push(...events);
  }

  return allEvents;
}
