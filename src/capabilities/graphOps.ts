import type { CapabilityHandler } from "./CapabilityRegistry";
import type { SocialGraph } from "../graph/SocialGraph";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "graphOps" });

/**
 * Graph operations capability handler
 * Supports multiple graph operations based on the first argument
 */
export const graphOps: CapabilityHandler = async (args, context) => {
  if (args.length === 0) {
    throw new Error(
      "graph.* capability requires at least 1 argument: operation name",
    );
  }

  const operation = args[0];
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return getSafeDefault(operation || "");
  }

  try {
    switch (operation) {
      case "stats":
        return await handleStats(graph);

      case "all_pubkeys":
        return await handleAllPubkeys(graph);

      case "pubkey_exists":
        return await handlePubkeyExists(graph, args[1] || "");

      case "is_following":
        return await handleIsFollowing(graph, args[1] || "", args[2] || "");

      case "are_mutual":
        return await handleAreMutual(graph, args[1] || "", args[2] || "");

      default:
        throw new Error(`Unknown graph operation: ${operation}`);
    }
  } catch (error) {
    logger.warn(
      `Graph operation ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return getSafeDefault(operation || "");
  }
};

/**
 * Get graph statistics
 */
async function handleStats(graph: SocialGraph) {
  const stats = await graph.getStats();
  logger.debug(`Graph stats: ${JSON.stringify(stats)}`);
  return stats;
}

/**
 * Get all unique pubkeys in the graph
 */
async function handleAllPubkeys(graph: SocialGraph) {
  // This method might not exist on SocialGraph, return empty array as safe default
  const allPubkeys = await graph.getAllUsersInGraph();
  logger.debug("All pubkeys in graph:", allPubkeys.length);
  return allPubkeys;
}

/**
 * Check if a pubkey exists in the graph
 */
async function handlePubkeyExists(graph: SocialGraph, pubkey: string) {
  if (!pubkey) {
    throw new Error("pubkey_exists requires a pubkey argument");
  }
  const exists = await graph.isInGraph(pubkey);
  logger.debug(`${pubkey} exists in graph: ${exists}`);
  return exists;
}

/**
 * Check if followerPubkey follows followedPubkey
 */
async function handleIsFollowing(
  graph: SocialGraph,
  followerPubkey: string,
  followedPubkey: string,
) {
  if (!followerPubkey || !followedPubkey) {
    throw new Error(
      "is_following requires followerPubkey and followedPubkey arguments",
    );
  }
  const isFollowing = await graph.doesFollow(followerPubkey, followedPubkey);
  logger.debug(`${followerPubkey} follows ${followedPubkey}: ${isFollowing}`);
  return isFollowing;
}

/**
 * Check if two pubkeys mutually follow each other
 */
async function handleAreMutual(
  graph: SocialGraph,
  pubkey1: string,
  pubkey2: string,
) {
  if (!pubkey1 || !pubkey2) {
    throw new Error("are_mutual requires pubkey1 and pubkey2 arguments");
  }
  const areMutual = await graph.areMutualFollows(pubkey1, pubkey2);
  logger.debug(`${pubkey1} and ${pubkey2} are mutual: ${areMutual}`);
  return areMutual;
}

/**
 * Get safe default values for graph operations when graph is not initialized
 */
function getSafeDefault(operation: string): unknown {
  switch (operation) {
    case "stats":
      return { totalFollows: 0, uniqueFollowers: 0, uniqueFollowed: 0 };

    case "all_pubkeys":
      return [];

    case "pubkey_exists":
      return false;

    case "is_following":
      return false;

    case "are_mutual":
      return false;

    case "degree":
      return { outDegree: 0, inDegree: 0 };

    default:
      return null;
  }
}
