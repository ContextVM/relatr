import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import {
  readRequiredNonNegativeNumberArg,
  requireGraph,
} from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphUsersWithinDistance" });

/**
 * Get all pubkeys reachable from the current graph root within the given distance.
 */
export const graphUsersWithinDistance: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = requireGraph(context);
  const distance = readRequiredNonNegativeNumberArg(
    "graph.users_within_distance",
    args,
    "distance",
  );

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
