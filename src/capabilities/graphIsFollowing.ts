import type { CapabilityHandler } from "./CapabilityRegistry";
import type { SocialGraph } from "../graph/SocialGraph";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "graphIsFollowing" });

/**
 * Check if followerPubkey follows followedPubkey
 */
export const graphIsFollowing: CapabilityHandler = async (args, context) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const followerPubkey = args[0];
  const followedPubkey = args[1];

  if (!followerPubkey || !followedPubkey) {
    throw new Error(
      "is_following requires followerPubkey and followedPubkey arguments",
    );
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return false;
  }

  try {
    const isFollowing = await graph.doesFollow(followerPubkey, followedPubkey);
    logger.debug(`${followerPubkey} follows ${followedPubkey}: ${isFollowing}`);
    return isFollowing;
  } catch (error) {
    logger.warn(
      `Graph is_following failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
