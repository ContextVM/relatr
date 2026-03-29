import { Logger } from "@/utils/Logger";
import type { CapabilityHandler } from "../CapabilityRegistry";
import { requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphStats" });

/**
 * Get comprehensive graph statistics
 */
export const graphStats: CapabilityHandler = async (_args, context) => {
  const graph = requireGraph(context);

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
