import { MetricDescriptionRegistry } from "../validators/MetricDescriptionRegistry";
import type { IEloPluginEngine } from "./EloPluginEngine";

/**
 * NullEloPluginEngine - Null-object implementation of EloPluginEngine
 *
 * This class provides a no-op implementation of the EloPluginEngine interface.
 * It is used when Elo plugins are disabled, allowing MetricsValidator to always
 * have an engine to call without conditional checks.
 *
 * Benefits:
 * - Eliminates optional dependency (eloEngine?:)
 * - Removes all "if (this.eloEngine)" checks
 * - Cleaner, more predictable code
 * - Easier to extract as a library later
 */
export class NullEloPluginEngine implements IEloPluginEngine {
  private initialized = true;
  private metricDescriptions: MetricDescriptionRegistry;

  constructor() {
    this.metricDescriptions = new MetricDescriptionRegistry();
  }

  /**
   * Initialize engine - no-op for null object
   */
  async initialize(): Promise<void> {
    // No-op - null object is always "initialized"
  }

  /**
   * Evaluate all loaded plugins for a target pubkey
   * Returns empty metrics for null object
   */
  async evaluateForPubkey(input: {
    targetPubkey: string;
    sourcePubkey?: string;
  }): Promise<Record<string, number>> {
    // Return empty metrics - no plugins to evaluate
    return {};
  }

  /**
   * Get number of loaded plugins
   */
  getPluginCount(): number {
    return 0;
  }

  /**
   * Check if engine has been initialized
   */
  isInitialized(): boolean {
    return true;
  }

  /**
   * Get metric descriptions registry
   */
  getMetricDescriptions(): MetricDescriptionRegistry {
    return this.metricDescriptions;
  }

  /**
   * Get resolved plugin weights
   * Returns empty object for null object
   */
  getResolvedWeights(): Record<string, number> {
    return {};
  }

  /**
   * Get plugin names
   * Returns empty array for null object
   */
  getPluginNames(): string[] {
    return [];
  }
}
