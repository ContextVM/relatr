import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphAllPubkeys" });

/**
 * Get all unique pubkeys in the social graph
 */
export const graphAllPubkeys: CapabilityHandler = async (_args, context) => {
  const graph = requireGraph(context);

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
