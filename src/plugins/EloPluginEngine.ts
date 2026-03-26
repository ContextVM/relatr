import type { SocialGraph } from "../graph/SocialGraph";
import type { RelayPool } from "applesauce-relay";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import type { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";
import { registerBuiltInCapabilities } from "../capabilities/registerBuiltInCapabilities";
import { runPlugins } from "./EloPluginRunner";
import type { CapabilityRunCache, PortablePlugin } from "./plugin-types";
import type { ValidationRunContext } from "@/validation/ValidationRunContext";
import { Logger } from "../utils/Logger";
import type { RelatrConfig } from "@/types";
import { MetricDescriptionRegistry } from "../validators/MetricDescriptionRegistry";
import { resolvePluginWeights } from "./resolvePluginWeights";
import { mapWithConcurrency } from "@/utils/mapWithConcurrency";

const logger = new Logger({ service: "EloPluginEngine" });

export interface EloPluginEngineDeps {
  pool: RelayPool;
  relays: string[];
  graph: SocialGraph;
  nip05CacheStore?: Nip05CacheStore;
}

/**
 * Common interface for Elo plugin engines
 * Both EloPluginEngine and NullEloPluginEngine implement this interface
 */
export interface IEloPluginEngine {
  initialize(): Promise<void>;
  reloadFromPlugins(input: {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights?: Record<string, number>;
  }): Promise<void>;
  getRuntimeState(): {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights: Record<string, number>;
  };
  evaluateForPubkey(input: {
    targetPubkey: string;
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
    validationRunContext?: ValidationRunContext;
  }): Promise<Record<string, number>>;
  evaluateBatchForPubkeys(input: {
    targetPubkeys: string[];
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
    validationRunContext?: ValidationRunContext;
  }): Promise<Map<string, Record<string, number>>>;
  getPluginCount(): number;
  isInitialized(): boolean;
  getMetricDescriptions(): MetricDescriptionRegistry;
  getResolvedWeights(): Record<string, number>;
  getPluginNames(): string[];
}

/**
 * EloPluginEngine - Central facade for Elo portable plugins
 *
 * This engine provides a single entrypoint for all Elo plugin operations:
 * - Plugin runtime execution (plugins are provided externally)
 * - Capability registration and execution
 * - Plugin evaluation for pubkeys
 *
 * The engine owns internal wiring and configuration, reducing redundancy
 * across call sites while maintaining decoupling and portability.
 */
export class EloPluginEngine implements IEloPluginEngine {
  private plugins: PortablePlugin[] = [];
  private registry: CapabilityRegistry;
  private executor: CapabilityExecutor;
  private initialized = false;
  private metricDescriptions: MetricDescriptionRegistry;
  private resolvedWeights: Record<string, number> = {};
  private enabledByKey: Record<string, boolean> = {};
  private weightOverridesByKey: Record<string, number> = {};

  constructor(
    private config: RelatrConfig,
    private deps: EloPluginEngineDeps,
  ) {
    // Create registry and executor (but don't register capabilities yet)
    this.registry = new CapabilityRegistry();
    // Create capability executor
    this.executor = new CapabilityExecutor(this.registry);
    this.metricDescriptions = new MetricDescriptionRegistry();
  }

  /**
   * Initialize engine and register built-in capabilities
   * This should be called once during application startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn("EloPluginEngine already initialized");
      return;
    }

    logger.info("Initializing EloPluginEngine");

    try {
      // Validate dependencies
      if (!this.deps.pool) {
        throw new Error("RelayPool dependency is required");
      }
      if (!this.deps.relays || this.deps.relays.length === 0) {
        throw new Error("At least one relay is required");
      }
      if (!this.deps.graph) {
        throw new Error("SocialGraph dependency is required");
      }

      this.plugins = [];
      this.enabledByKey = {};
      this.weightOverridesByKey = { ...(this.config.eloPluginWeights || {}) };

      // Register built-in capabilities (nostr, graph, http)
      logger.info("Registering built-in capabilities");
      registerBuiltInCapabilities(this.registry);
      logger.info("Built-in capabilities registered");

      // Resolve plugin weights (Tier 1: Config override, Tier 2: Manifest default, Tier 3: Proportional distribution)
      logger.info("Resolving plugin weights");
      this.resolvedWeights = this.resolvePluginWeights(
        this.weightOverridesByKey,
      );
      logger.info(
        `Resolved weights for ${Object.keys(this.resolvedWeights).length} plugins`,
      );

      this.initialized = true;
      logger.info("EloPluginEngine initialization complete");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize EloPluginEngine: ${errorMsg}`);
      throw error;
    }
  }

  async reloadFromPlugins(input: {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights?: Record<string, number>;
  }): Promise<void> {
    if (!this.initialized) {
      throw new Error(
        "EloPluginEngine not initialized. Call initialize() first.",
      );
    }

    const nextPlugins = [...input.plugins];
    const nextEnabled = { ...input.enabled };
    const nextOverrides = { ...input.weightOverrides };

    const nextMetricDescriptions = new MetricDescriptionRegistry();
    for (const plugin of nextPlugins) {
      const namespacedName = `${plugin.pubkey}:${plugin.manifest.name}`;
      const description =
        plugin.manifest.description || "No description available";
      nextMetricDescriptions.register(namespacedName, description);
    }

    const nextResolvedWeights =
      input.resolvedWeights ||
      this.resolvePluginWeights(nextOverrides, nextPlugins);

    this.plugins = nextPlugins;
    this.enabledByKey = nextEnabled;
    this.weightOverridesByKey = nextOverrides;
    this.metricDescriptions = nextMetricDescriptions;
    this.resolvedWeights = nextResolvedWeights;
  }

  getRuntimeState(): {
    plugins: PortablePlugin[];
    enabled: Record<string, boolean>;
    weightOverrides: Record<string, number>;
    resolvedWeights: Record<string, number>;
  } {
    return {
      plugins: [...this.plugins],
      enabled: { ...this.enabledByKey },
      weightOverrides: { ...this.weightOverridesByKey },
      resolvedWeights: { ...this.resolvedWeights },
    };
  }

  /**
   * Evaluate all loaded plugins for a target pubkey
   *
   * @param input - Evaluation input with target pubkey and optional source pubkey
   * @returns Record mapping namespaced plugin names (<pubkey>:<name>) to their scores
   */
  async evaluateForPubkey(input: {
    targetPubkey: string;
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
    validationRunContext?: ValidationRunContext;
  }): Promise<Record<string, number>> {
    if (!this.initialized) {
      throw new Error(
        "EloPluginEngine not initialized. Call initialize() first.",
      );
    }

    if (this.plugins.length === 0) {
      logger.debug("No plugins loaded, returning empty metrics");
      return {};
    }

    logger.debug(
      `Evaluating ${this.plugins.length} plugins for pubkey: ${input.targetPubkey}`,
    );

    // Build context for plugin execution
    // The engine injects dependencies (graph, pool, relays) once here
    const context = {
      targetPubkey: input.targetPubkey,
      sourcePubkey: input.sourcePubkey,
      graph: this.deps.graph,
      pool: this.deps.pool,
      relays: this.deps.relays,
      capRunCache: input.capRunCache,
      validationRunContext: input.validationRunContext,
      nip05CacheStore: this.deps.nip05CacheStore,
    };

    // Run plugins using existing runner (which handles capability provisioning)
    const metricKeyFilter =
      input.metricKeys && input.metricKeys.length > 0
        ? new Set(input.metricKeys)
        : null;

    const pluginsToRun = metricKeyFilter
      ? this.plugins.filter((plugin) =>
          metricKeyFilter.has(`${plugin.pubkey}:${plugin.manifest.name}`),
        )
      : this.plugins;

    const pluginMetrics = await runPlugins(
      pluginsToRun,
      context,
      this.executor,
      {
        eloPluginTimeoutMs: this.config.eloPluginTimeoutMs || 30000,
        capTimeoutMs: this.config.capTimeoutMs || 10000,
        nip05ResolveTimeoutMs: this.config.nip05ResolveTimeoutMs || 5000,
        nip05CacheTtlSeconds: this.config.nip05CacheTtlSeconds,
        nip05DomainCooldownSeconds: this.config.nip05DomainCooldownSeconds,
        maxRoundsPerPlugin: this.config.eloMaxRoundsPerPlugin,
        maxRequestsPerRound: this.config.eloMaxRequestsPerRound,
        maxTotalRequestsPerPlugin: this.config.eloMaxTotalRequestsPerPlugin,
      },
    );

    logger.debug(
      `Plugin evaluation complete for ${input.targetPubkey}: ${Object.keys(pluginMetrics).length} metrics`,
    );

    return pluginMetrics;
  }

  async evaluateBatchForPubkeys(input: {
    targetPubkeys: string[];
    sourcePubkey?: string;
    metricKeys?: string[];
    capRunCache?: CapabilityRunCache;
    validationRunContext?: ValidationRunContext;
  }): Promise<Map<string, Record<string, number>>> {
    if (!this.initialized) {
      throw new Error(
        "EloPluginEngine not initialized. Call initialize() first.",
      );
    }

    const results = new Map<string, Record<string, number>>();

    if (input.targetPubkeys.length === 0 || this.plugins.length === 0) {
      for (const pubkey of input.targetPubkeys) {
        results.set(pubkey, {});
      }
      return results;
    }

    const metricKeyFilter =
      input.metricKeys && input.metricKeys.length > 0
        ? new Set(input.metricKeys)
        : null;

    const pluginsToRun = metricKeyFilter
      ? this.plugins.filter((plugin) =>
          metricKeyFilter.has(`${plugin.pubkey}:${plugin.manifest.name}`),
        )
      : this.plugins;

    if (pluginsToRun.length === 0) {
      for (const pubkey of input.targetPubkeys) {
        results.set(pubkey, {});
      }
      return results;
    }

    logger.debug(
      `Evaluating ${pluginsToRun.length} plugins for ${input.targetPubkeys.length} pubkeys in batch`,
    );

    const contexts = input.targetPubkeys.map((targetPubkey) => ({
      targetPubkey,
      sourcePubkey: input.sourcePubkey,
      graph: this.deps.graph,
      pool: this.deps.pool,
      relays: this.deps.relays,
      capRunCache: input.capRunCache,
      validationRunContext: input.validationRunContext,
      nip05CacheStore: this.deps.nip05CacheStore,
    }));

    const concurrency = this.config.eloBatchPubkeyConcurrency ?? 8;

    await mapWithConcurrency(contexts, concurrency, async (context) => {
      const metrics = await runPlugins(pluginsToRun, context, this.executor, {
        eloPluginTimeoutMs: this.config.eloPluginTimeoutMs || 30000,
        capTimeoutMs: this.config.capTimeoutMs || 10000,
        nip05ResolveTimeoutMs: this.config.nip05ResolveTimeoutMs || 5000,
        nip05CacheTtlSeconds: this.config.nip05CacheTtlSeconds,
        nip05DomainCooldownSeconds: this.config.nip05DomainCooldownSeconds,
        maxRoundsPerPlugin: this.config.eloMaxRoundsPerPlugin,
        maxRequestsPerRound: this.config.eloMaxRequestsPerRound,
        maxTotalRequestsPerPlugin: this.config.eloMaxTotalRequestsPerPlugin,
      });
      results.set(context.targetPubkey, metrics);
      return metrics;
    });

    return results;
  }
  /**
   * Get number of loaded plugins
   */
  getPluginCount(): number {
    return this.plugins.length;
  }

  /**
   * Check if engine has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get metric descriptions registry
   * @returns MetricDescriptionRegistry instance with all Elo plugin descriptions
   */
  getMetricDescriptions(): MetricDescriptionRegistry {
    return this.metricDescriptions;
  }

  /**
   * Resolve plugin weights using three-tier system:
   * - Tier 1: Config override (highest priority)
   * - Tier 2: Manifest default
   * - Tier 3: Proportional distribution of remaining weight
   * @returns Record mapping namespaced plugin names to their weights
   */
  private resolvePluginWeights(
    overrides?: Record<string, number>,
    pluginsInput?: PortablePlugin[],
  ): Record<string, number> {
    const sourcePlugins = pluginsInput || this.plugins;
    const configOverrides = overrides || this.config.eloPluginWeights || {};
    const weights = resolvePluginWeights({
      plugins: sourcePlugins,
      overrides: configOverrides,
    });
    logger.info(`Resolved weights for ${Object.keys(weights).length} plugins`);
    logger.debug("Resolved weights:", weights);
    return weights;
  }

  /**
   * Get resolved plugin weights
   * @returns Record mapping namespaced plugin names to their weights
   */
  getResolvedWeights(): Record<string, number> {
    return { ...this.resolvedWeights };
  }

  /**
   * Get namespaced plugin names
   * @returns Array of namespaced plugin names
   */
  getPluginNames(): string[] {
    return this.plugins.map((p) => `${p.pubkey}:${p.manifest.name}`);
  }
}
