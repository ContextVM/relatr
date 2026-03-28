import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";

const logger = new Logger({ service: "graphDistanceFromRoot" });

/**
 * Get distance in hops from the current graph root to a target pubkey.
 */
export const graphDistanceFromRoot: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const pubkey =
    args &&
    typeof args === "object" &&
    typeof (args as { pubkey?: unknown }).pubkey === "string"
      ? (args as { pubkey: string }).pubkey
      : null;

  if (!pubkey) {
    throw new Error(
      "graph.distance_from_root requires a 'pubkey' field in the arguments object",
    );
  }

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
