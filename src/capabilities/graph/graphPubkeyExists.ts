import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";

const logger = new Logger({ service: "graphPubkeyExists" });

/**
 * Check if a pubkey exists in the graph
 */
export const graphPubkeyExists: CapabilityHandler = async (args, context) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const pubkey = args[0];
  if (!pubkey) {
    throw new Error("pubkey_exists requires a pubkey argument");
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return false;
  }

  try {
    const exists = await graph.isInGraph(pubkey);
    logger.debug(`${pubkey} exists in graph: ${exists}`);
    return exists;
  } catch (error) {
    logger.warn(
      `Graph pubkey_exists failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
