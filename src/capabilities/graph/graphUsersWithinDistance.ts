import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";

const logger = new Logger({ service: "graphUsersWithinDistance" });

/**
 * Get all pubkeys reachable from the current graph root within the given distance.
 */
export const graphUsersWithinDistance: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = context.graph;

  if (!graph) {
    throw new Error("SocialGraph not available in context");
  }

  const distance =
    args &&
    typeof args === "object" &&
    typeof (args as { distance?: unknown }).distance === "number"
      ? (args as { distance: number }).distance
      : null;

  if (distance === null || !Number.isFinite(distance) || distance < 0) {
    throw new Error(
      "graph.users_within_distance requires a non-negative numeric 'distance' field in the arguments object",
    );
  }

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return [];
  }

  try {
    const pubkeys = await graph.getUsersUpToDistance(distance);
    logger.debug(`Users within distance ${distance}: ${pubkeys.length}`);
    return pubkeys;
  } catch (error) {
    logger.warn(
      `Graph users_within_distance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
};
