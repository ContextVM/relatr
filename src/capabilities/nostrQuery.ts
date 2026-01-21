import type { CapabilityHandler } from "./CapabilityRegistry";
import type { NostrEvent, Filter } from "nostr-tools";
import { Logger } from "../utils/Logger";
import { withTimeout } from "../utils/utils";

const logger = new Logger({ service: "nostrQuery" });

/**
 * Nostr query capability handler
 * Queries Nostr relays for events matching a filter
 *
 * Args:
 * - args[0]: JSON string representing Nostr filter
 *
 * Returns: Array of NostrEvent objects (max 1000 events, sorted deterministically)
 *
 * Safe defaults: Returns empty array on any error (missing context, invalid filter,
 * timeout, relay errors) to ensure plugins can continue execution.
 */
export const nostrQuery: CapabilityHandler = async (args, context) => {
  // Validate arguments
  if (args.length === 0) {
    logger.warn("nostr.query called without filter argument");
    return [];
  }

  const pool = context.pool;
  const relays = context.relays;

  // Validate context - return empty array instead of throwing
  if (!pool) {
    logger.warn("RelayPool not available in context");
    return [];
  }

  if (!relays || relays.length === 0) {
    logger.warn("No relays available in context");
    return [];
  }

  // Parse filter from JSON string
  let filter: Filter;
  try {
    filter = JSON.parse(args[0]!) as Filter;
  } catch (error) {
    logger.warn(
      `Invalid filter JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  // Enforce deterministic constraints
  // Max limit of 1000 events
  if (filter.limit && filter.limit > 1000) {
    logger.warn(
      `Filter limit ${filter.limit} exceeds maximum of 1000, clamping to 1000`,
    );
    filter.limit = 1000;
  } else if (!filter.limit) {
    filter.limit = 1000;
  }

  logger.debug(`Querying nostr with filter: ${JSON.stringify(filter)}`);

  try {
    const timeoutMs = context.config.capTimeoutMs || 10000;
    const events = await withTimeout(
      new Promise<NostrEvent[]>((resolve, reject) => {
        const collectedEvents: NostrEvent[] = [];
        const subscription = pool.request(relays, filter).subscribe({
          next: (event) => {
            collectedEvents.push(event);
          },
          error: (error) => {
            subscription.unsubscribe();
            reject(error);
          },
          complete: () => {
            subscription.unsubscribe();
            resolve(collectedEvents);
          },
        });
      }),
      timeoutMs,
    );

    logger.debug(`nostr.query returned ${events.length} events`);
    return events;
  } catch (error) {
    logger.warn(
      `nostr.query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
};
