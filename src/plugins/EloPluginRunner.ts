import type {
  PortablePlugin,
  EloInput,
  EloEvaluationResult,
} from "./plugin-types";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { evaluateElo } from "./EloEvaluator";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "EloPluginRunner" });

export interface PluginRunnerContext {
  targetPubkey: string;
  sourcePubkey?: string;
  searchQuery?: string;
  graph?: any;
  pool?: any;
  relays?: string[];
}

/**
 * Helper function to set nested values in an object
 */
function setNestedValue(
  obj: Record<string, any>,
  path: string,
  value: any,
): void {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue; // Skip empty parts

    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part];
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    current[lastPart] = value;
  }
}

/**
 * Run a single Elo plugin with capability provisioning
 */
export async function runPlugin(
  plugin: PortablePlugin,
  context: PluginRunnerContext,
  registry: CapabilityRegistry,
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  },
): Promise<EloEvaluationResult> {
  const startTime = Date.now();

  try {
    logger.debug(`Running plugin: ${plugin.manifest.name}`);

    // Build capability results object with nested structure
    const capResults: Record<string, any> = {};

    // Execute each capability declared in the manifest
    for (const cap of plugin.manifest.caps) {
      if (!registry.isEnabled(cap.name)) {
        logger.warn(`Capability ${cap.name} is disabled, skipping`);
        setNestedValue(capResults, cap.name, null);
        continue;
      }

      // Create capability request
      const request = {
        capName: cap.name,
        args: cap.args,
        timeoutMs: config.capTimeoutMs,
        cacheKey: `${plugin.id}:${context.targetPubkey}:${cap.name}`,
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

      // Execute capability
      const response = await executor.execute(request, capContext, plugin.id);

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

    // Add search query if provided
    if (context.searchQuery) {
      (eloInput as any).searchQuery = context.searchQuery;
    }

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
  registry: CapabilityRegistry,
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

  // Run plugins sequentially to avoid overwhelming resources
  // In the future, we could add concurrency limits here
  for (const plugin of plugins) {
    const result = await runPlugin(plugin, context, registry, executor, config);

    // Use plugin name as the metric key
    metrics[plugin.manifest.name] = result.score;

    if (!result.success) {
      logger.warn(`Plugin ${plugin.manifest.name} failed: ${result.error}`);
    }
  }

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
  registry: CapabilityRegistry,
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
    const metrics = await runPlugins(
      plugins,
      context,
      registry,
      executor,
      config,
    );
    results.set(context.targetPubkey, metrics);
  }

  logger.info(`Batch processing completed`);

  return results;
}
