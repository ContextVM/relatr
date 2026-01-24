import type { CapabilityHandler } from "./CapabilityRegistry";
import type { SocialGraph } from "../graph/SocialGraph";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "graphAreMutual" });

/**
 * Check if two pubkeys mutually follow each other
 */
export const graphAreMutual: CapabilityHandler = async (args, context) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const pubkey1 = args?.a;
  const pubkey2 = args?.b;

  if (!pubkey1 || !pubkey2) {
    throw new Error(
      "are_mutual requires 'a' and 'b' fields in arguments object",
    );
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return false;
  }

  try {
    const areMutual = await graph.areMutualFollows(pubkey1, pubkey2);
    logger.debug(`${pubkey1} and ${pubkey2} are mutual: ${areMutual}`);
    return areMutual;
  } catch (error) {
    logger.warn(
      `Graph are_mutual failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
