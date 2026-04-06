import { RELATR_CAPABILITIES } from "@contextvm/relo";

import type { CapabilityRegistry } from "./CapabilityRegistry";
import { graphAllPubkeys } from "./graph/graphAllPubkeys";
import { graphAreMutual } from "./graph/graphAreMutual";
import { graphDegree } from "./graph/graphDegree";
import { graphDegreeHistogram } from "./graph/graphDegreeHistogram";
import { graphDistanceBetween } from "./graph/graphDistanceBetween";
import { graphDistanceFromRoot } from "./graph/graphDistanceFromRoot";
import { graphIsFollowing } from "./graph/graphIsFollowing";
import { graphPubkeyExists } from "./graph/graphPubkeyExists";
import { graphStats } from "./graph/graphStats";
import { graphUsersWithinDistance } from "./graph/graphUsersWithinDistance";
import { httpNip05Resolve } from "./http/httpNip05Resolve";
import { nostrQuery } from "./nostr/nostrQuery";

/**
 * Registers all built-in capabilities with the capability registry.
 * This should be called once during engine initialization.
 *
 * Built-in capabilities include:
 * - [`RELATR_CAPABILITIES.nostrQuery`](relo/src/catalog.ts:403): Query Nostr relays for events
 * - [`RELATR_CAPABILITIES.httpNip05Resolve`](relo/src/catalog.ts:413): Resolve NIP-05 identifiers to pubkeys
 * - [`RELATR_CAPABILITIES.graphStats`](relo/src/catalog.ts:404): Get comprehensive graph statistics
 * - [`RELATR_CAPABILITIES.graphAllPubkeys`](relo/src/catalog.ts:405): Get all unique pubkeys in the graph
 * - [`RELATR_CAPABILITIES.graphAreMutual`](relo/src/catalog.ts:408): Check if two pubkeys mutually follow each other
 * - [`RELATR_CAPABILITIES.graphDistanceFromRoot`](relo/src/catalog.ts:409): Get hop distance from the current root to a pubkey
 * - [`RELATR_CAPABILITIES.graphDistanceBetween`](relo/src/catalog.ts:410): Get hop distance between two pubkeys
 * - [`RELATR_CAPABILITIES.graphDegree`](relo/src/catalog.ts:412): Get in/out degree counts for a pubkey
 * - [`RELATR_CAPABILITIES.graphDegreeHistogram`](relo/src/catalog.ts:413): Get degree plus root-aware neighbor distance histograms for a pubkey
 * - [`RELATR_CAPABILITIES.graphIsFollowing`](relo/src/catalog.ts:407): Check if one pubkey follows another
 * - [`RELATR_CAPABILITIES.graphPubkeyExists`](relo/src/catalog.ts:406): Check if a pubkey exists in the graph
 * - [`RELATR_CAPABILITIES.graphUsersWithinDistance`](relo/src/catalog.ts:411): Get pubkeys within N hops of the current root
 *
 * @param registry - The CapabilityRegistry instance to register capabilities with
 */
export function registerBuiltInCapabilities(
  registry: CapabilityRegistry,
): void {
  // Nostr capabilities
  registry.register(RELATR_CAPABILITIES.nostrQuery, nostrQuery);

  // HTTP capabilities
  registry.register(RELATR_CAPABILITIES.httpNip05Resolve, httpNip05Resolve);

  // Graph capabilities
  registry.register(RELATR_CAPABILITIES.graphStats, graphStats);
  registry.register(RELATR_CAPABILITIES.graphAllPubkeys, graphAllPubkeys);
  registry.register(RELATR_CAPABILITIES.graphAreMutual, graphAreMutual);
  registry.register(
    RELATR_CAPABILITIES.graphDistanceFromRoot,
    graphDistanceFromRoot,
  );
  registry.register(
    RELATR_CAPABILITIES.graphDistanceBetween,
    graphDistanceBetween,
  );
  registry.register(RELATR_CAPABILITIES.graphDegree, graphDegree);
  registry.register(
    RELATR_CAPABILITIES.graphDegreeHistogram,
    graphDegreeHistogram,
  );
  registry.register(RELATR_CAPABILITIES.graphIsFollowing, graphIsFollowing);
  registry.register(RELATR_CAPABILITIES.graphPubkeyExists, graphPubkeyExists);
  registry.register(
    RELATR_CAPABILITIES.graphUsersWithinDistance,
    graphUsersWithinDistance,
  );
}
