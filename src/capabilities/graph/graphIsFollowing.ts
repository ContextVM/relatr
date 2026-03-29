import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphIsFollowing" });

/**
 * Check if followerPubkey follows followedPubkey
 */
export const graphIsFollowing: CapabilityHandler = async (args, context) => {
  const graph = requireGraph(context);
  const followerPubkey = readRequiredStringArg(
    "graph.is_following",
    args,
    "followerPubkey",
  );
  const followedPubkey = readRequiredStringArg(
    "graph.is_following",
    args,
    "followedPubkey",
  );

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
