import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphDistanceFromRoot" });

/**
 * Get distance in hops from the current graph root to a target pubkey.
 */
export const graphDistanceFromRoot: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = requireGraph(context);
  const pubkey = readRequiredStringArg(
    "graph.distance_from_root",
    args,
    "pubkey",
  );

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return 1000;
  }

  try {
    const distance = await graph.getDistance(pubkey);
    logger.debug(`Distance from root to ${pubkey}: ${distance}`);
    return distance;
  } catch (error) {
    logger.warn(
      `Graph distance_from_root failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1000;
  }
};
