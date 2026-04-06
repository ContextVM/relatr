import type { CapabilityHandler } from "../CapabilityRegistry";
import { Logger } from "../../utils/Logger";
import { readRequiredStringArg, requireGraph } from "./graphRuntimeGuards";

const logger = new Logger({ service: "graphDegreeHistogram" });

const EMPTY_HISTOGRAM_RESULT = {
  outDegree: 0,
  inDegree: 0,
  outboundDistanceHistogram: {},
  inboundDistanceHistogram: {},
};

/**
 * Get degree counts plus root-aware inbound/outbound neighbor histograms for a pubkey.
 */
export const graphDegreeHistogram: CapabilityHandler = async (
  args,
  context,
) => {
  const graph = requireGraph(context);
  const pubkey = readRequiredStringArg(
    "graph.degree_histogram",
    args,
    "pubkey",
  );

  if (!graph.isInitialized()) {
    logger.warn("SocialGraph not initialized, returning safe defaults");
    return EMPTY_HISTOGRAM_RESULT;
  }

  try {
    const histogram = await graph.getPubkeyDegreeHistogram(pubkey);
    logger.debug(`Degree histogram loaded for ${pubkey}`);
    return histogram;
  } catch (error) {
    logger.warn(
      `Graph degree histogram failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EMPTY_HISTOGRAM_RESULT;
  }
};
