import type { SocialGraph } from "../graph/SocialGraph";
import type { RelayPool } from "applesauce-relay";
import { loadPlugins } from "./PortablePluginLoader";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { registerBuiltInCapabilities } from "../capabilities/registerBuiltInCapabilities";
import { runPlugins } from "./EloPluginRunner";
import type { PortablePlugin } from "./plugin-types";
import { Logger } from "../utils/Logger";
import type { RelatrConfig } from "@/types";
import { MetricDescriptionRegistry } from "../validators/MetricDescriptionRegistry";

const logger = new Logger({ service: "EloPluginEngine" });

export interface EloPluginEngineDeps {
  pool: RelayPool;
  relays: string[];
  graph: SocialGraph;
}

/**
 * Common interface for Elo plugin engines
 * Both EloPluginEngine and NullEloPluginEngine implement this interface
 */
export interface IEloPluginEngine {
  initialize(): Promise<void>;
  evaluateForPubkey(input: {
    targetPubkey: string;
    sourcePubkey?: string;
  }): Promise<Record<string, number>>;
  getPluginCount(): number;
  isInitialized(): boolean;
  getMetricDescriptions(): MetricDescriptionRegistry;
}

/**
 * EloPluginEngine - Central facade for Elo portable plugins
 *
 * This engine provides a single entrypoint for all Elo plugin operations:
 * - Plugin loading (startup-load only)
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
   * Initialize engine - load plugins and register built-in capabilities
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

      // Load plugins from configured directory if enabled
      if (this.config.eloPluginsEnabled && this.config.eloPluginsDir) {
        logger.info(`Loading plugins from ${this.config.eloPluginsDir}`);
        this.plugins = await loadPlugins(this.config.eloPluginsDir);
        logger.info(`Loaded ${this.plugins.length} plugins`);
      } else {
        logger.info("Elo plugins disabled or no directory configured");
        this.plugins = [];
      }

      // Register built-in capabilities (nostr, graph, http)
      logger.info("Registering built-in capabilities");
      registerBuiltInCapabilities(this.registry);
      logger.info("Built-in capabilities registered");

      // Register metric descriptions for all loaded plugins
      logger.info("Registering metric descriptions for plugins");
      for (const plugin of this.plugins) {
        const namespacedName = `${plugin.pubkey}:${plugin.manifest.name}`;
        const description =
          plugin.manifest.description || "No description available";
        this.metricDescriptions.register(namespacedName, description);
        logger.debug(`Registered description for plugin: ${namespacedName}`);
      }
      logger.info(`Registered ${this.plugins.length} plugin descriptions`);

      this.initialized = true;
      logger.info("EloPluginEngine initialization complete");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize EloPluginEngine: ${errorMsg}`);
      throw error;
    }
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
    };

    // Run plugins using existing runner (which handles capability provisioning)
    const pluginMetrics = await runPlugins(
      this.plugins,
      context,
      this.executor,
      {
        eloPluginTimeoutMs: this.config.eloPluginTimeoutMs || 30000,
        capTimeoutMs: this.config.capTimeoutMs || 10000,
      },
    );

    // Convert simple plugin names to namespaced names (<pubkey>:<name>)
    const namespacedMetrics: Record<string, number> = {};
    for (const plugin of this.plugins) {
      const simpleName = plugin.manifest.name;
      const namespacedName = `${plugin.pubkey}:${simpleName}`;

      if (pluginMetrics[simpleName] !== undefined) {
        namespacedMetrics[namespacedName] = pluginMetrics[simpleName];
      }
    }

    logger.debug(
      `Plugin evaluation complete for ${input.targetPubkey}: ${Object.keys(namespacedMetrics).length} metrics`,
    );

    return namespacedMetrics;
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
}
