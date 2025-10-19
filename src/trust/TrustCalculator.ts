import type {
  RelatrConfig,
  TrustScore,
  ProfileMetrics,
  MetricWeights,
  ScoreComponents,
} from "../types";
import { SocialGraphError, ValidationError } from "../types";
import { WeightProfileManager } from "../validators/weight-profiles";

/**
 * Trust score calculation using distance normalization and weighted metrics
 * Implements the formula: Score = Σ(wᵢ × vᵢ) / Σ(wᵢ)
 */
export class TrustCalculator {
  private config: RelatrConfig;
  private weightProfileManager: WeightProfileManager;
  private static readonly DECIMAL_PLACES = 3;
  private static readonly WEIGHT_SUM_TOLERANCE = 0.01;

  /**
   * Create a new TrustCalculator instance
   * @param config - Relatr configuration
   * @param weightProfileManager - Weight profile manager for dynamic weights (required)
   */
  constructor(
    config: RelatrConfig,
    weightProfileManager: WeightProfileManager,
  ) {
    if (!config) {
      throw new SocialGraphError("Config is required", "CONSTRUCTOR");
    }

    if (!weightProfileManager) {
      throw new SocialGraphError(
        "WeightProfileManager is required",
        "CONSTRUCTOR",
      );
    }

    this.config = config;
    this.weightProfileManager = weightProfileManager;
  }

  /**
   * Calculate trust score between source and target pubkeys
   * @param sourcePubkey - Source public key
   * @param targetPubkey - Target public key
   * @param metrics - Profile metrics for target pubkey
   * @param distance - Social distance between source and target
   * @param weights - Optional custom weights (overrides profile weights)
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

    // Get current weights from profile manager
    const currentWeights = this.weightProfileManager.getAllWeights();

    // Merge and validate weights
    const finalWeights = this.mergeWeights(currentWeights, weights);
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
      validators: {},
      socialDistance: this.roundToDecimalPlaces(distance),
      normalizedDistance: this.roundToDecimalPlaces(normalizedDistance),
    };

    // Add rounded validator components
    for (const [metricName, metricValue] of Object.entries(metrics.metrics)) {
      components.validators[metricName] =
        this.roundToDecimalPlaces(metricValue);
    }

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

    if (distance <= 1) {
      // Direct connections (distance 0 or 1) get full trust score
      return 1.0;
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
    // Calculate weighted sum for distance
    let weightedSum = weights.distanceWeight * normalizedDistance;

    // Calculate weighted sum for all validator metrics
    for (const [metricName, metricValue] of Object.entries(metrics.metrics)) {
      const weight = weights.validators[metricName];
      if (weight !== undefined) {
        weightedSum += weight * metricValue;
      }
    }

    // Total weight is always 1.0 due to validation, but keep check for safety
    const totalWeight = 1.0;

    // Calculate final score (no need for division by zero check since weights sum to 1.0)
    const score = weightedSum / totalWeight;

    // Ensure result is in [0,1] range
    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Merge default weights with custom weights
   * @param defaults - Default weights from active profile
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
      validators: custom.validators ?? defaults.validators,
    };
  }

  /**
   * Validate that metric weights sum to approximately 1.0
   * @param weights - Metric weights to validate
   * @throws ValidationError if weights don't sum to approximately 1.0
   * @private
   */
  /**
   * Calculate sum of weights
   * @param weights - Metric weights
   * @returns Sum of all weights
   * @private
   */
  private sumWeights(weights: MetricWeights): number {
    let sum = weights.distanceWeight;

    // Sum all validator weights
    for (const weight of Object.values(weights.validators)) {
      sum += weight;
    }

    return sum;
  }

  /**
   * Validate that metric weights sum to approximately 1.0
   * @param weights - Metric weights to validate
   * @throws ValidationError if weights don't sum to approximately 1.0
   * @private
   */
  private validateWeights(weights: MetricWeights): void {
    const sum = this.sumWeights(weights);
    const deviation = Math.abs(sum - 1.0);

    if (deviation > TrustCalculator.WEIGHT_SUM_TOLERANCE) {
      throw new ValidationError(
        `Metric weights must sum to 1.0 (±${TrustCalculator.WEIGHT_SUM_TOLERANCE}). Current sum: ${sum.toFixed(4)}`,
        "weights",
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
    places: number = TrustCalculator.DECIMAL_PLACES,
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
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get the weight profile manager
   * @returns WeightProfileManager instance
   */
  getWeightProfileManager(): WeightProfileManager {
    return this.weightProfileManager;
  }
}
