import type {
  PortablePlugin,
  EloInput,
  EloEvaluationResult,
  BaseContext,
} from "./plugin-types";
import type { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { evaluateElo } from "./EloEvaluator";
import { Logger } from "../utils/Logger";
import { PlanningStore } from "./PlanningStore";
import { planRelatrDeclarations } from "./relatrPlanner";

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
  now?: number,
): Promise<EloEvaluationResult> {
  const startTime = Date.now();

  try {
    logger.debug(`Running plugin: ${plugin.manifest.name}`);

    // 1. Build initial Elo input for planning
    // Use provided now for determinism across plugins in a single evaluation run,
    // otherwise compute it (for standalone plugin runs).
    const nowValue = now ?? Math.floor(Date.now() / 1000);
    const eloInput: EloInput = {
      targetPubkey: context.targetPubkey,
      sourcePubkey: context.sourcePubkey || null,
      now: nowValue,
      provisioned: {},
    };

    // Planning store scope:
    // - If provided (runPlugins), it's shared across plugins for dedupe.
    // - If not provided (runPlugin), create one for this single evaluation.
    const effectivePlanningStore = planningStore ?? new PlanningStore();

    // 2. Plan: extract RELATR blocks and evaluate args_expr sequentially
    const { strippedSource, plannedDecls } = planRelatrDeclarations(
      plugin.content,
      eloInput,
    );

    // 3. Provision: collect and batch execute deduped requests
    // Build list of requests to execute (filtering by allowlist first)
    const requestsToExecute: Array<{
      request: { capName: string; argsJson: unknown; timeoutMs: number };
      requestKey: string;
    }> = [];

    for (const decl of plannedDecls) {
      if (!decl.requestKey) continue;

      // Enforce allowlist
      if (!plugin.manifest.caps.includes(decl.capName)) {
        logger.warn(
          `Plugin ${plugin.manifest.name} requested capability ${decl.capName} which is not in its allowlist`,
        );
        // We don't execute it, it will resolve to null during scoring
        continue;
      }

      // We already evaluated args_expr and validated JSON-only during planning
      const argsJson = decl.argsJsonOrNull;
      if (argsJson === null) continue;

      requestsToExecute.push({
        request: {
          capName: decl.capName,
          argsJson,
          timeoutMs: config.capTimeoutMs,
        },
        requestKey: decl.requestKey,
      });
    }

    // Create capability context (used for all requests in this plugin)
    const capContext = {
      targetPubkey: context.targetPubkey,
      sourcePubkey: context.sourcePubkey,
      config: {
        capTimeoutMs: config.capTimeoutMs,
      },
      graph: context.graph,
      pool: context.pool,
      relays: context.relays,
    };

    // Execute all requests in batch for better performance
    if (requestsToExecute.length > 0) {
      await executor.executeBatch(
        requestsToExecute,
        capContext,
        effectivePlanningStore,
      );
    }

    // 4. Build provisioned by id for scoring.
    // Missing/failed/unplannable requests resolve to null.
    const provisionedById: Record<string, unknown | null> = {};
    for (const decl of plannedDecls) {
      if (!decl.requestKey) {
        provisionedById[decl.id] = null;
        continue;
      }
      const v = effectivePlanningStore.get(decl.requestKey);
      provisionedById[decl.id] = v === undefined ? null : (v as any);
    }
    eloInput.provisioned = provisionedById;

    // 5. Score: evaluate Elo after stripping RELATR blocks
    const result = await evaluateElo(
      plugin,
      eloInput,
      config.eloPluginTimeoutMs,
      strippedSource,
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

  // Compute now once for determinism across all plugins in this evaluation run
  // This ensures _.now is constant for a single evaluation run per spec §3
  const now = Math.floor(Date.now() / 1000);

  // Run plugins sequentially to avoid overwhelming resources
  for (const plugin of plugins) {
    const result = await runPlugin(
      plugin,
      context,
      executor,
      config,
      planningStore,
      now,
    );

    // Use plugin name as the metric key
    metrics[plugin.manifest.name] = result.score;

    if (!result.success) {
      logger.warn(`Plugin ${plugin.manifest.name} failed: ${result.error}`);
    }
  }

  // Clear planning store after evaluation
  planningStore.clear();

  logger.info(`Completed running ${plugins.length} plugins`);

  return metrics;
}

/**
 * Run plugins in batch mode for multiple pubkeys
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

  for (const context of contexts) {
    const metrics = await runPlugins(plugins, context, executor, config);
    results.set(context.targetPubkey, metrics);
  }

  logger.info(`Batch processing completed`);

  return results;
}
