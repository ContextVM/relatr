import type {
  PortablePlugin,
  EloInput,
  EloEvaluationResult,
  BaseContext,
} from "./plugin-types";
import type { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { evaluateElo } from "./EloEvaluator";
import { setNestedValue } from "../utils/objectPath";
import { Logger } from "../utils/Logger";
import { PlanningStore } from "./PlanningStore";

const logger = new Logger({ service: "EloPluginRunner" });

export interface PluginRunnerContext extends BaseContext {
  searchQuery?: string;
}

/**
 * Run a single Elo plugin with capability provisioning
 */
export async function runPlugin(
  plugin: PortablePlugin,
  context: PluginRunnerContext,
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  },
  planningStore?: PlanningStore,
): Promise<EloEvaluationResult> {
  const startTime = Date.now();

  try {
    logger.debug(`Running plugin: ${plugin.manifest.name}`);

    // Build capability results object with nested structure
    const capResults: Record<string, unknown> = {};

    // Execute each capability declared in the manifest
    for (const cap of plugin.manifest.caps) {
      // Create capability request
      const request = {
        capName: cap.name,
        args: cap.args,
        timeoutMs: config.capTimeoutMs,
      };

      // Create capability context
      const capContext = {
        targetPubkey: context.targetPubkey,
        sourcePubkey: context.sourcePubkey,
        config: {
          capTimeoutMs: config.capTimeoutMs,
        },
        // Pass additional context for capabilities that need it
        graph: context.graph,
        pool: context.pool,
        relays: context.relays,
      };

      // Execute capability (executor handles enablement checks and planning store)
      const response = await executor.execute(
        request,
        capContext,
        plugin.id,
        planningStore,
      );

      if (response.ok) {
        setNestedValue(capResults, cap.name, response.value);
        logger.debug(`Capability ${cap.name} executed successfully`);
      } else {
        logger.warn(`Capability ${cap.name} failed: ${response.error}`);
        setNestedValue(capResults, cap.name, null);
      }
    }

    // Build Elo input object
    const eloInput: EloInput = {
      pubkey: context.targetPubkey,
      sourcePubkey: context.sourcePubkey,
      now: Date.now(),
      cap: capResults,
    };

    // Evaluate Elo code
    const result = await evaluateElo(
      plugin,
      eloInput,
      config.eloPluginTimeoutMs,
    );

    logger.debug(
      `Plugin ${plugin.manifest.name} completed in ${Date.now() - startTime}ms`,
    );

    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    logger.error(`Plugin ${plugin.manifest.name} failed: ${errorMsg}`);

    return {
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      score: 0.0,
      success: false,
      error: errorMsg,
      elapsedMs,
    };
  }
}

/**
 * Run multiple plugins and return a metrics map
 */
export async function runPlugins(
  plugins: PortablePlugin[],
  context: PluginRunnerContext,
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  },
): Promise<Record<string, number>> {
  const metrics: Record<string, number> = {};

  if (plugins.length === 0) {
    return metrics;
  }

  logger.info(
    `Running ${plugins.length} Elo plugins for pubkey: ${context.targetPubkey}`,
  );

  // Create planning store for this evaluation to avoid redundant capability calls
  const planningStore = new PlanningStore();

  // Run plugins sequentially to avoid overwhelming resources
  // In the future, we could add concurrency limits here
  for (const plugin of plugins) {
    const result = await runPlugin(
      plugin,
      context,
      executor,
      config,
      planningStore,
    );

    // Use plugin name as the metric key
    metrics[plugin.manifest.name] = result.score;

    if (!result.success) {
      logger.warn(`Plugin ${plugin.manifest.name} failed: ${result.error}`);
    }
  }

  // Clear planning store after evaluation to free memory and ensure fresh data next time
  planningStore.clear();

  logger.info(`Completed running ${plugins.length} plugins`);

  return metrics;
}

/**
 * Run plugins in batch mode for multiple pubkeys
 * This enables potential optimizations like batching capability requests
 */
export async function runPluginsBatch(
  plugins: PortablePlugin[],
  contexts: PluginRunnerContext[],
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  },
): Promise<Map<string, Record<string, number>>> {
  const results = new Map<string, Record<string, number>>();

  logger.info(`Running plugins in batch mode for ${contexts.length} pubkeys`);

  // For now, run sequentially for each context
  // Future optimization: collect all capability requests across all plugins and contexts,
  // group by capability name and args, execute once, then fan out results
  for (const context of contexts) {
    const metrics = await runPlugins(plugins, context, executor, config);
    results.set(context.targetPubkey, metrics);
  }

  logger.info(`Batch processing completed`);

  return results;
}
