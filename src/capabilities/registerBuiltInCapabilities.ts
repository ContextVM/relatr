import type { CapabilityRegistry } from "./CapabilityRegistry";
import { nostrQuery } from "./nostrQuery";
import { httpNip05Resolve } from "./httpNip05Resolve";
import { graphStats } from "./graphStats";
import { graphAllPubkeys } from "./graphAllPubkeys";
import { graphAreMutual } from "./graphAreMutual";
import { graphIsFollowing } from "./graphIsFollowing";
import { graphPubkeyExists } from "./graphPubkeyExists";

/**
 * Registers all built-in capabilities with the capability registry.
 * This should be called once during engine initialization.
 *
 * Built-in capabilities include:
 * - nostr.query: Query Nostr relays for events
 * - http.nip05_resolve: Resolve NIP-05 identifiers to pubkeys
 * - graph.stats: Get comprehensive graph statistics
 * - graph.all_pubkeys: Get all unique pubkeys in the graph
 * - graph.are_mutual: Check if two pubkeys mutually follow each other
 * - graph.is_following: Check if one pubkey follows another
 * - graph.pubkey_exists: Check if a pubkey exists in the graph
 *
 * @param registry - The CapabilityRegistry instance to register capabilities with
 */
export function registerBuiltInCapabilities(
  registry: CapabilityRegistry,
): void {
  // Nostr capabilities
  registry.register("nostr.query", nostrQuery);

  // HTTP capabilities
  registry.register("http.nip05_resolve", httpNip05Resolve);

  // Graph capabilities
  registry.register("graph.stats", graphStats);
  registry.register("graph.all_pubkeys", graphAllPubkeys);
  registry.register("graph.are_mutual", graphAreMutual);
  registry.register("graph.is_following", graphIsFollowing);
  registry.register("graph.pubkey_exists", graphPubkeyExists);
}
