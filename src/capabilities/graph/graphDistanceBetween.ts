import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";

const logger = new Logger({ service: "graphDistanceBetween" });

/**
 * Get distance in hops between two pubkeys.
 */
export const graphDistanceBetween: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const sourcePubkey =
    args &&
    typeof args === "object" &&
    typeof (args as { sourcePubkey?: unknown }).sourcePubkey === "string"
      ? (args as { sourcePubkey: string }).sourcePubkey
      : null;
  const targetPubkey =
    args &&
    typeof args === "object" &&
    typeof (args as { targetPubkey?: unknown }).targetPubkey === "string"
      ? (args as { targetPubkey: string }).targetPubkey
      : null;

  if (!sourcePubkey || !targetPubkey) {
    throw new Error(
      "graph.distance_between requires 'sourcePubkey' and 'targetPubkey' fields in the arguments object",
    );
  }

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
