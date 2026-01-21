import type {
  RelatrConfig,
  TrustScore,
  ProfileMetrics,
  MetricWeights,
  ScoreComponents,
} from "../types";
import { SocialGraphError } from "../types";
import { normalizeDistance, nowSeconds } from "../utils/utils";
import { DEFAULT_DISTANCE_WEIGHT } from "../config";

/**
 * Trust score calculation using distance normalization and weighted Elo plugin metrics
 * Implements the formula: Score = distanceWeight * normalizedDistance + Σ(pluginWeight × pluginValue)
 *
 * Plugin weights are resolved by EloPluginEngine using a three-tier system:
 * - Tier 1: Config override (highest priority)
 * - Tier 2: Manifest default
 * - Tier 3: Proportional distribution of remaining weight
 */
export class TrustCalculator {
  private config: RelatrConfig;
  private pluginWeights: Record<string, number>;

  /**
   * Create a new TrustCalculator instance
   * @param config - Relatr configuration
   * @param pluginWeights - Resolved plugin weights from EloPluginEngine
   */
  constructor(
    config: RelatrConfig,
    pluginWeights: Record<string, number> = {},
  ) {
    if (!config) {
      throw new SocialGraphError("Config is required", "CONSTRUCTOR");
    }

    this.config = config;
    this.pluginWeights = pluginWeights;
  }

  /**
   * Calculate trust score between source and target pubkeys
   * @param sourcePubkey - Source public key
   * @param targetPubkey - Target public key
   * @param metrics - Profile metrics for target pubkey
   * @param distance - Social distance between source and target
   * @returns Complete trust score with all components
   * @throws SocialGraphError if calculation fails
   */
  calculate(
    sourcePubkey: string,
    targetPubkey: string,
    metrics: ProfileMetrics,
    distance: number,
  ): TrustScore {
    // Validate inputs
    if (!sourcePubkey || typeof sourcePubkey !== "string") {
      throw new SocialGraphError(
        "Source pubkey must be a non-empty string",
        "CALCULATE",
      );
    }
    if (!targetPubkey || typeof targetPubkey !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "CALSTRUCTOR",
      );
    }
    if (!metrics) {
      throw new SocialGraphError("Metrics are required", "CALCULATE");
    }
    if (typeof distance !== "number" || distance < 0) {
      throw new SocialGraphError(
        "Distance must be a non-negative number",
        "CALCULATE",
      );
    }

    // Use default distance weight
    const distanceWeight = DEFAULT_DISTANCE_WEIGHT;

    // Normalize distance
    const normalizedDistance = normalizeDistance(
      distance,
      this.config.decayFactor,
    );

    // Calculate weighted score
    const rawScore = this.calculateWeightedScore(
      metrics,
      normalizedDistance,
      distanceWeight,
    );

    // Round final score and components for consistency and readability
    const score = this.roundToDecimalPlaces(rawScore);

    // Create score components with rounded values
    const components: ScoreComponents = {
      distanceWeight: this.roundToDecimalPlaces(distanceWeight),
      validators: {},
      socialDistance: this.roundToDecimalPlaces(distance),
      normalizedDistance: this.roundToDecimalPlaces(normalizedDistance),
    };

    // Add rounded validator components with weights
    for (const [metricName, metricValue] of Object.entries(metrics.metrics)) {
      if (
        !metricName ||
        metricName === "undefined" ||
        metricValue === undefined
      ) {
        continue;
      }
      const weight = this.pluginWeights[metricName];
      components.validators[metricName] = {
        score: this.roundToDecimalPlaces(metricValue),
      };
    }

    // Create trust score object
    return {
      sourcePubkey,
      targetPubkey,
      score,
      components,
      computedAt: nowSeconds(),
    };
  }

  /**
   * Calculate weighted score using the formula: Score = distanceWeight * normalizedDistance + Σ(wᵢ × vᵢ)
   * @param metrics - Profile metrics
   * @param normalizedDistance - Normalized distance value
   * @param distanceWeight - Weight for distance component
   * @returns Final trust score [0,1]
   * @private
   */
  private calculateWeightedScore(
    metrics: ProfileMetrics,
    normalizedDistance: number,
    distanceWeight: number,
  ): number {
    // Calculate weighted sum for distance
    let weightedSum = distanceWeight * normalizedDistance;

    // Calculate weighted sum for all plugin metrics
    for (const [metricName, metricValue] of Object.entries(metrics.metrics)) {
      const weight = this.pluginWeights[metricName];
      if (weight !== undefined && weight > 0) {
        weightedSum += weight * metricValue;
      }
    }

    // Ensure result is in [0,1] range
    return Math.max(0.0, Math.min(1.0, weightedSum));
  }

  /**
   * Round a number to a specified number of decimal places
   * @param value - The value to round
   * @param places - Number of decimal places (default: 2)
   * @returns Rounded value
   * @private
   */
  private roundToDecimalPlaces(value: number, places: number = 2): number {
    const multiplier = Math.pow(10, places);
    return Math.round(value * multiplier) / multiplier;
  }
}
