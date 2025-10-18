import type {
  RelatrConfig,
  TrustScore,
  ProfileMetrics,
  MetricWeights,
  ScoreComponents,
} from "../types";
import { SocialGraphError, ValidationError } from "../types";

/**
 * Trust score calculation using distance normalization and weighted metrics
 * Implements the formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
 */
export class TrustCalculator {
  private config: RelatrConfig;
  private static readonly DECIMAL_PLACES = 3;
  private static readonly WEIGHT_SUM_TOLERANCE = 0.01;

  /**
   * Create a new TrustCalculator instance
   * @param config - Relatr configuration
   */
  constructor(config: RelatrConfig) {
    if (!config) {
      throw new SocialGraphError("Config is required", "CONSTRUCTOR");
    }

    // Validate that weights sum to approximately 1.0
    this.validateWeights(config.weights);

    this.config = config;
  }

  /**
   * Calculate trust score between source and target pubkeys
   * @param sourcePubkey - Source public key
   * @param targetPubkey - Target public key
   * @param metrics - Profile metrics for target pubkey
   * @param distance - Social distance between source and target
   * @param weights - Optional custom weights (overrides config weights)
   * @returns Complete trust score with all components
   * @throws SocialGraphError if calculation fails
   */
  calculate(
    sourcePubkey: string,
    targetPubkey: string,
    metrics: ProfileMetrics,
    distance: number,
    weights?: Partial<MetricWeights>,
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
        "CALCULATE",
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

    // Merge and validate weights
    const finalWeights = this.mergeWeights(this.config.weights, weights);
    this.validateWeights(finalWeights);

    // Normalize distance
    const normalizedDistance = this.normalizeDistance(distance);

    // Calculate weighted score
    const rawScore = this.calculateWeightedScore(
      metrics,
      normalizedDistance,
      finalWeights,
    );

    // Round final score and components for consistency and readability
    const score = this.roundToDecimalPlaces(rawScore);
    
    // Create score components with rounded values
    const components: ScoreComponents = {
      distanceWeight: this.roundToDecimalPlaces(finalWeights.distanceWeight),
      nip05Valid: this.roundToDecimalPlaces(finalWeights.nip05Valid),
      lightningAddress: this.roundToDecimalPlaces(finalWeights.lightningAddress),
      eventKind10002: this.roundToDecimalPlaces(finalWeights.eventKind10002),
      reciprocity: this.roundToDecimalPlaces(finalWeights.reciprocity),
      socialDistance: this.roundToDecimalPlaces(distance),
      normalizedDistance: this.roundToDecimalPlaces(normalizedDistance),
    };

    // Create trust score object
    return {
      sourcePubkey,
      targetPubkey,
      score,
      components,
      computedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Normalize distance using exponential decay formula: e^(-α × distance)
   * @param distance - Social distance in hops
   * @returns Normalized distance value [0,1]
   */
  normalizeDistance(distance: number): number {
    if (
      typeof distance !== "number" ||
      distance < 0 ||
      isNaN(distance) ||
      !isFinite(distance)
    ) {
      throw new SocialGraphError(
        "Distance must be a non-negative finite number",
        "NORMALIZE_DISTANCE",
      );
    }

    // Special case: distance = 1000 → normalized = 0.0 (unreachable)
    if (distance === 1000) {
      return 0.0;
    }

    // Apply exponential decay: e^(-α × distance)
    const decayFactor = this.config.decayFactor;
    const normalized = Math.exp(-decayFactor * distance);

    // Ensure result is in [0,1] range
    return Math.max(0.0, Math.min(1.0, normalized));
  }

  /**
   * Calculate weighted score using the formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
   * @param metrics - Profile metrics
   * @param normalizedDistance - Normalized distance value
   * @param weights - Metric weights
   * @returns Final trust score [0,1]
   * @private
   */
  private calculateWeightedScore(
    metrics: ProfileMetrics,
    normalizedDistance: number,
    weights: MetricWeights,
  ): number {
    // Calculate weighted sum
    const weightedSum =
      weights.distanceWeight * normalizedDistance +
      weights.nip05Valid * metrics.nip05Valid +
      weights.lightningAddress * metrics.lightningAddress +
      weights.eventKind10002 * metrics.eventKind10002 +
      weights.reciprocity * metrics.reciprocity;

    // Calculate total weight
    const totalWeight =
      weights.distanceWeight +
      weights.nip05Valid +
      weights.lightningAddress +
      weights.eventKind10002 +
      weights.reciprocity;

    // Avoid division by zero
    if (totalWeight === 0) {
      return 0.0;
    }

    // Calculate final score
    const score = weightedSum / totalWeight;

    // Ensure result is in [0,1] range
    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Merge default weights with custom weights
   * @param defaults - Default weights from config
   * @param custom - Optional custom weights to override defaults
   * @returns Merged weights
   * @private
   */
  private mergeWeights(
    defaults: MetricWeights,
    custom?: Partial<MetricWeights>,
  ): MetricWeights {
    if (!custom) {
      return defaults;
    }

    return {
      distanceWeight: custom.distanceWeight ?? defaults.distanceWeight,
      nip05Valid: custom.nip05Valid ?? defaults.nip05Valid,
      lightningAddress: custom.lightningAddress ?? defaults.lightningAddress,
      eventKind10002: custom.eventKind10002 ?? defaults.eventKind10002,
      reciprocity: custom.reciprocity ?? defaults.reciprocity,
    };
  }

  /**
   * Validate that metric weights sum to approximately 1.0
   * @param weights - Metric weights to validate
   * @throws ValidationError if weights don't sum to approximately 1.0
   * @private
   */
  private validateWeights(weights: MetricWeights): void {
    const sum =
      weights.distanceWeight +
      weights.nip05Valid +
      weights.lightningAddress +
      weights.eventKind10002 +
      weights.reciprocity;

    const deviation = Math.abs(sum - 1.0);
    
    if (deviation > TrustCalculator.WEIGHT_SUM_TOLERANCE) {
      throw new ValidationError(
        `Metric weights must sum to 1.0 (±${TrustCalculator.WEIGHT_SUM_TOLERANCE}). Current sum: ${sum.toFixed(4)}`,
        "weights"
      );
    }
  }

  /**
   * Round a number to a specified number of decimal places
   * @param value - The value to round
   * @param places - Number of decimal places (default: 3)
   * @returns Rounded value
   * @private
   */
  private roundToDecimalPlaces(
    value: number,
    places: number = TrustCalculator.DECIMAL_PLACES
  ): number {
    const multiplier = Math.pow(10, places);
    return Math.round(value * multiplier) / multiplier;
  }

  /**
   * Get the current configuration
   * @returns Current RelatrConfig
   */
  getConfig(): RelatrConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration
   * @param newConfig - New configuration to use
   */
  updateConfig(newConfig: Partial<RelatrConfig>): void {
    if (newConfig.weights) {
      this.validateWeights(newConfig.weights);
    }
    this.config = { ...this.config, ...newConfig };
  }
}
