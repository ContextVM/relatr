import { MetricDescriptionRegistry } from "../validators/MetricDescriptionRegistry";
import type { IEloPluginEngine } from "./EloPluginEngine";
import type { CapabilityRunCache, PortablePlugin } from "./plugin-types";
import type { FactDomain } from "@/validation/fact-dependencies";

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

  async reloadFromPlugins(_input: {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights?: Record<string, number>;
  }): Promise<void> {
    // No-op
  }

  getRuntimeState(): {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights: Record<string, number>;
    metricFactDependencies?: Map<string, Set<FactDomain>>;
  } {
    return {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
      metricFactDependencies: new Map(),
    };
  }

  /**
   * Evaluate all loaded plugins for a target pubkey
   * Returns empty metrics for null object
   */
  async evaluateForPubkey(_input: {
    targetPubkey: string;
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
  }): Promise<Record<string, number>> {
    // Return empty metrics - no plugins to evaluate
    return {};
  }

  async evaluateBatchForPubkeys(input: {
    targetPubkeys: string[];
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
  }): Promise<Map<string, Record<string, number>>> {
    return new Map(input.targetPubkeys.map((pubkey) => [pubkey, {}]));
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
