import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphPubkeyExists" });

/**
 * Check if a pubkey exists in the graph
 */
export const graphPubkeyExists: CapabilityHandler = async (args, context) => {
  const graph = requireGraph(context);
  const pubkey = readRequiredStringArg("graph.pubkey_exists", args, "pubkey");

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
