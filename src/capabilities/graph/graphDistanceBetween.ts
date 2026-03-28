import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphDistanceBetween" });

/**
 * Get distance in hops between two pubkeys.
 */
export const graphDistanceBetween: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = requireGraph(context);
  const sourcePubkey = readRequiredStringArg(
    "graph.distance_between",
    args,
    "sourcePubkey",
  );
  const targetPubkey = readRequiredStringArg(
    "graph.distance_between",
    args,
    "targetPubkey",
  );

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return 1000;
  }

  try {
    const distance = await graph.getDistanceBetween(sourcePubkey, targetPubkey);
    logger.debug(
      `Distance between ${sourcePubkey} and ${targetPubkey}: ${distance}`,
    );
    return distance;
  } catch (error) {
    logger.warn(
      `Graph distance_between failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1000;
  }
};
