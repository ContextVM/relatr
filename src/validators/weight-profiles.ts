import type { MetricWeights } from "../types";

/**
 * Weight profile interface for managing validation weights separately from plugins
 */
export interface WeightProfile {
  name: string;
  description?: string;
  distanceWeight: number;
  validatorWeights: Map<string, number>;
}

/**
 * Result of weight coverage validation
 */
export interface CoverageValidationResult {
  valid: boolean;
  warnings?: {
    missingWeights: string[];
    extraWeights: string[];
  };
}

/**
 * Manages weight profiles for validation system
 * Provides dynamic weight assignment separate from plugin implementations
 */
export class WeightProfileManager {
  private profiles = new Map<string, WeightProfile>();
  private activeProfile: WeightProfile | null = null;

  /**
   * Register a new weight profile
   * @param profile - Weight profile to register
   * @throws Error if profile validation fails
   */
  registerProfile(profile: WeightProfile): void {
    // Normalize profile if weights sum to more than 1.0
    const normalizedProfile = this.normalizeProfile(profile);

    // Validate profile
    this.validateProfile(normalizedProfile);

    // Store the profile
    this.profiles.set(normalizedProfile.name, normalizedProfile);

    // Set as active if it's the first one
    if (!this.activeProfile) {
      this.activeProfile = normalizedProfile;
    }
  }

  /**
   * Activate a weight profile by name
   * @param name - Name of the profile to activate
   * @throws Error if profile is not found
   */
  activateProfile(name: string): void {
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(
        `Weight profile '${name}' not found. Available profiles: ${Array.from(this.profiles.keys()).join(", ")}`,
      );
    }
    this.activeProfile = profile;
  }

  /**
   * Get the currently active profile
   * @returns Active weight profile or null if none is active
   */
  getActiveProfile(): WeightProfile | null {
    return this.activeProfile;
  }

  /**
   * Get weight for a specific validator from the active profile
   * @param validatorName - Name of the validator
   * @returns Weight value or 0 if not found
   */
  getWeight(validatorName: string): number {
    if (!this.activeProfile) {
      throw new Error(
        "No active weight profile. Call activateProfile() first.",
      );
    }
    return this.activeProfile.validatorWeights.get(validatorName) ?? 0;
  }

  /**
   * Get all weights from the active profile in MetricWeights format
   * @returns MetricWeights object with all current weights
   */
  getAllWeights(): MetricWeights {
    if (!this.activeProfile) {
      throw new Error(
        "No active weight profile. Call activateProfile() first.",
      );
    }

    return {
      distanceWeight: this.activeProfile.distanceWeight,
      validators: Object.fromEntries(this.activeProfile.validatorWeights),
    };
  }

  /**
   * Get all registered profiles
   * @returns Array of all registered weight profiles
   */
  getAllProfiles(): WeightProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get a specific profile by name
   * @param name - Name of the profile to retrieve
   * @returns Weight profile or undefined if not found
   */
  getProfile(name: string): WeightProfile | undefined {
    return this.profiles.get(name);
  }

  /**
   * Validate that weights sum to approximately 1.0
   * @param profile - Profile to validate
   * @throws Error if validation fails
   */
  private validateProfile(profile: WeightProfile): void {
    // Calculate total weight
    let totalWeight = profile.distanceWeight;
    for (const weight of profile.validatorWeights.values()) {
      totalWeight += weight;
    }

    // Check if total is approximately 1.0 (with small tolerance for floating point)
    const tolerance = 0.01;
    if (Math.abs(totalWeight - 1.0) > tolerance) {
      throw new Error(
        `Weight profile '${profile.name}' has invalid total weight: ${totalWeight.toFixed(4)}. ` +
          `Weights must sum to 1.0.`,
      );
    }

    // Check for negative weights
    if (profile.distanceWeight < 0) {
      throw new Error(
        `Weight profile '${profile.name}' has negative distance weight`,
      );
    }

    for (const [name, weight] of profile.validatorWeights.entries()) {
      if (weight < 0) {
        throw new Error(
          `Weight profile '${profile.name}' has negative weight for validator '${name}'`,
        );
      }
    }
  }

  /**
   * Normalize profile weights if they sum to more than 1.0
   * @param profile - Profile to normalize
   * @returns Normalized profile with weights summing to 1.0
   * @private
   */
  private normalizeProfile(profile: WeightProfile): WeightProfile {
    // Calculate total weight
    let totalWeight = profile.distanceWeight;
    for (const weight of profile.validatorWeights.values()) {
      totalWeight += weight;
    }

    // If total weight is approximately 1.0, return as-is
    const tolerance = 0.01;
    if (Math.abs(totalWeight - 1.0) <= tolerance) {
      return profile;
    }

    // If total weight exceeds 1.0, normalize all weights
    if (totalWeight > 1.0) {
      console.warn(
        `Weight profile '${profile.name}' has total weight ${totalWeight.toFixed(4)}. ` +
          `Normalizing to sum to 1.0.`,
      );

      const normalizedValidatorWeights = new Map<string, number>();
      const normalizationFactor = 1.0 / totalWeight;

      // Normalize distance weight
      const normalizedDistanceWeight =
        profile.distanceWeight * normalizationFactor;

      // Normalize all validator weights
      for (const [name, weight] of profile.validatorWeights.entries()) {
        normalizedValidatorWeights.set(name, weight * normalizationFactor);
      }

      return {
        ...profile,
        distanceWeight: normalizedDistanceWeight,
        validatorWeights: normalizedValidatorWeights,
        description: profile.description
          ? `${profile.description} (normalized from ${totalWeight.toFixed(3)})`
          : `Normalized from ${totalWeight.toFixed(3)}`,
      };
    }

    // If total weight is less than 1.0, return as-is (will be caught by validation)
    return profile;
  }

  /**
   * Validate coverage between registered plugins and active profile weights
   * @param pluginNames - Array of registered plugin names
   * @returns Coverage validation result
   */
  validateCoverage(pluginNames: string[]): CoverageValidationResult {
    if (!this.activeProfile) {
      throw new Error(
        "No active weight profile. Call activateProfile() first.",
      );
    }

    const weightedNames = Array.from(
      this.activeProfile.validatorWeights.keys(),
    );

    const missingWeights = pluginNames.filter(
      (name) => !weightedNames.includes(name),
    );
    const extraWeights = weightedNames.filter(
      (name) => !pluginNames.includes(name),
    );

    if (missingWeights.length > 0 || extraWeights.length > 0) {
      return {
        valid: false,
        warnings: {
          missingWeights,
          extraWeights,
        },
      };
    }

    return { valid: true };
  }

  /**
   * Create a weight profile from MetricWeights
   * @param name - Profile name
   * @param weights - MetricWeights to convert
   * @param description - Optional profile description
   * @returns WeightProfile instance
   */
  static fromMetricWeights(
    name: string,
    weights: MetricWeights,
    description?: string,
  ): WeightProfile {
    return {
      name,
      description,
      distanceWeight: weights.distanceWeight,
      validatorWeights: new Map(Object.entries(weights.validators)),
    };
  }
}
