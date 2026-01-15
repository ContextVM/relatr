import type { CapabilityHandler } from "./CapabilityRegistry";
import type { SocialGraph } from "../graph/SocialGraph";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "graphStats" });

/**
 * Get comprehensive graph statistics
 */
export const graphStats: CapabilityHandler = async (_args, context) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return { totalFollows: 0, uniqueFollowers: 0, uniqueFollowed: 0 };
  }

  try {
    const stats = await graph.getStats();
    logger.debug(`Graph stats: ${JSON.stringify(stats)}`);
    return stats;
  } catch (error) {
    logger.warn(
      `Graph stats failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { totalFollows: 0, uniqueFollowers: 0, uniqueFollowed: 0 };
  }
};
