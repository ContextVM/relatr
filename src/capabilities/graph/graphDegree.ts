import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphDegree" });

/**
 * Get in/out degree counts for a pubkey in the graph.
 */
export const graphDegree: CapabilityHandler = async (args, context) => {
  const graph = requireGraph(context);
  const pubkey = readRequiredStringArg("graph.degree", args, "pubkey");

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return { outDegree: 0, inDegree: 0 };
  }

  try {
    const degree = await graph.getPubkeyDegree(pubkey);
    logger.debug(
      `Degree for ${pubkey}: outDegree=${degree.outDegree}, inDegree=${degree.inDegree}`,
    );
    return degree;
  } catch (error) {
    logger.warn(
      `Graph degree failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { outDegree: 0, inDegree: 0 };
  }
};
