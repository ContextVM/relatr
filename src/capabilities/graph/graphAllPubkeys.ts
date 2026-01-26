import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";

const logger = new Logger({ service: "graphAllPubkeys" });

/**
 * Get all unique pubkeys in the social graph
 */
export const graphAllPubkeys: CapabilityHandler = async (_args, context) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return [];
  }

  try {
    const allPubkeys = await graph.getAllUsersInGraph();
    logger.debug(`All pubkeys in graph: ${allPubkeys.length}`);
    return allPubkeys;
  } catch (error) {
    logger.warn(
      `Graph all_pubkeys failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
};
