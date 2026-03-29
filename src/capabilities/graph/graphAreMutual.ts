import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphAreMutual" });

/**
 * Check if two pubkeys mutually follow each other
 */
export const graphAreMutual: CapabilityHandler = async (args, context) => {
  const graph = requireGraph(context);
  const pubkey1 = readRequiredStringArg("graph.are_mutual", args, "a");
  const pubkey2 = readRequiredStringArg("graph.are_mutual", args, "b");

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
