import type {
  PortablePlugin,
  EloInput,
  EloEvaluationResult,
  BaseContext,
  CapabilityResponse,
} from "./plugin-types";
import type { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { Logger } from "../utils/Logger";
import { PlanningStore } from "./PlanningStore";
import {
  compilePluginProgram,
  evalExprAtPlanTime,
  isDoCallExpr,
} from "./relatrPlanner";
import { generateRequestKey } from "./requestKey";
import { withTimeout } from "../utils/utils";
import type { EloPluginDebugPlan } from "./EloPluginDebug";
import { buildDebugPlan } from "./EloPluginDebug";
import { normalizeNip05 } from "../capabilities/http/utils/httpNip05Normalize";

const logger = new Logger({ service: "EloPluginRunner" });

export interface PluginRunnerContext extends BaseContext {
  searchQuery?: string;
}

export type HostPolicyLimits = {
  /** Maximum number of `plan`/`then` rounds allowed per plugin */
  maxRoundsPerPlugin?: number;
  /** Maximum number of plannable `do` calls allowed in a single round */
  maxRequestsPerRound?: number;
  /** Maximum number of plannable `do` calls allowed across all rounds */
  maxTotalRequestsPerPlugin?: number;
};

const DEFAULT_HOST_POLICY_LIMITS: Required<HostPolicyLimits> = {
  // Conservative defaults; override via runPlugin/runPlugins config.
  maxRoundsPerPlugin: 8,
  maxRequestsPerRound: 32,
  maxTotalRequestsPerPlugin: 128,
};

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
  } & HostPolicyLimits,
  planningStore?: PlanningStore,
  now?: number,
): Promise<EloEvaluationResult> {
  const { result } = await runPluginInternal(
    plugin,
    context,
    executor,
    config,
    {
      planningStore,
      now,
      includeDebug: false,
    },
  );
  return result;
}

/**
 * Run a plugin and return both score result and a v1 debug plan trace.
 *
 * This is intended for operator tooling / tests; the normal engine path uses
 * [`runPlugin()`](src/plugins/EloPluginRunner.ts:line) and does not allocate trace objects.
 */
export async function runPluginWithDebug(
  plugin: PortablePlugin,
  context: PluginRunnerContext,
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  } & HostPolicyLimits,
  planningStore?: PlanningStore,
  now?: number,
): Promise<{ result: EloEvaluationResult; debug: EloPluginDebugPlan }> {
  return runPluginInternal(plugin, context, executor, config, {
    planningStore,
    now,
    includeDebug: true,
  });
}

async function runPluginInternal(
  plugin: PortablePlugin,
  context: PluginRunnerContext,
  executor: CapabilityExecutor,
  config: {
    eloPluginTimeoutMs: number;
    capTimeoutMs: number;
  } & HostPolicyLimits,
  opts: {
    planningStore?: PlanningStore;
    now?: number;
    includeDebug: boolean;
  },
): Promise<{ result: EloEvaluationResult; debug: EloPluginDebugPlan }> {
  const startTime = Date.now();
  const limits = { ...DEFAULT_HOST_POLICY_LIMITS, ...config };

  const plannedDecls: EloPluginDebugPlan["plannedDecls"] = [];
  const provisioningOutcomes = new Map<string, CapabilityResponse>();

  try {
    logger.debug(`Running plugin: ${plugin.manifest.name}`);

    // Use provided now for determinism across plugins in a single evaluation run,
    // otherwise compute it (for standalone plugin runs).
    const nowValue = opts.now ?? Math.floor(Date.now() / 1000);
    const eloInput: EloInput = {
      targetPubkey: context.targetPubkey,
      sourcePubkey: context.sourcePubkey || null,
      now: nowValue,
    };

    // Planning store scope:
    // - If provided (runPlugins), it's shared across plugins for dedupe.
    // - If not provided (runPlugin), create one for this single evaluation.
    const effectivePlanningStore = opts.planningStore ?? new PlanningStore();

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
      capRunCache: context.capRunCache,
    };

    const main = async (): Promise<number> => {
      // Execute rounds sequentially, batching do-calls at end of each round.
      const { program } = compilePluginProgram(plugin.content);

      // Host policy: max rounds
      if (program.rounds.length > limits.maxRoundsPerPlugin) {
        throw new Error(
          `Host policy: too many rounds (${program.rounds.length} > ${limits.maxRoundsPerPlugin})`,
        );
      }

      // Execution state
      const env: Record<string, unknown> = {};
      const pendingRoundDoBindings: Array<{
        bindingName: string;
        requestKey: string;
      }> = [];

      // Provision: collect and batch execute requests (per-round)
      const requestsToExecute: Array<{
        request: { capName: string; argsJson: unknown; timeoutMs: number };
        requestKey: string;
      }> = [];

      // Per-round request dedupe so we never schedule duplicates inside the same batch.
      // (Cross-round and cross-plugin dedupe is handled by PlanningStore.)
      const roundRequestKeys = new Set<string>();

      let totalPlannableDoCalls = 0;

      for (
        let roundIndex = 0;
        roundIndex < program.rounds.length;
        roundIndex++
      ) {
        const round = program.rounds[roundIndex]!;
        pendingRoundDoBindings.length = 0;
        requestsToExecute.length = 0;
        roundRequestKeys.clear();

        let roundPlannableDoCalls = 0;

        // Evaluate bindings in order
        for (const binding of round.bindings) {
          if (isDoCallExpr(binding.value)) {
            // Evaluate args at plan-time.
            // Spec semantics: if args evaluation fails or yields a non-JSON value,
            // treat the request as unplannable and bind null (non-fatal).
            let argsValue: unknown;
            let requestKey: string | null = null;
            try {
              argsValue = evalExprAtPlanTime(
                binding.value.argsExpr,
                eloInput,
                env,
              );

              // Host policy: capability-specific argument normalization.
              // This improves request-key dedupe and downstream caching while
              // keeping plugin semantics unchanged.
              if (
                binding.value.capName === "http.nip05_resolve" &&
                argsValue &&
                typeof argsValue === "object" &&
                typeof (argsValue as { nip05?: string }).nip05 === "string"
              ) {
                argsValue = {
                  ...(argsValue as Record<string, unknown>),
                  nip05: normalizeNip05(
                    (argsValue as { nip05?: string }).nip05 as string,
                  ),
                };
              }

              requestKey = generateRequestKey(binding.value.capName, argsValue);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logger.warn(
                `Plugin ${plugin.manifest.name}: args evaluation failed for do '${binding.value.capName}' binding '${binding.name}': ${msg}`,
              );
              // Unplannable => bind null and continue.
              requestKey = null;
              argsValue = null;
            }

            if (opts.includeDebug) {
              plannedDecls.push({
                bindingName: binding.name,
                capName: binding.value.capName,
                requestKey,
                roundIndex,
              });
            }

            if (!requestKey) {
              // Unplannable args => bind null (failure semantics)
              env[binding.name] = null;
              continue;
            }

            roundPlannableDoCalls++;
            totalPlannableDoCalls++;

            // Host policy: limits
            if (roundPlannableDoCalls > limits.maxRequestsPerRound) {
              throw new Error(
                `Host policy: too many requests in round ${roundIndex} (${roundPlannableDoCalls} > ${limits.maxRequestsPerRound})`,
              );
            }
            if (totalPlannableDoCalls > limits.maxTotalRequestsPerPlugin) {
              throw new Error(
                `Host policy: too many total requests (${totalPlannableDoCalls} > ${limits.maxTotalRequestsPerPlugin})`,
              );
            }

            pendingRoundDoBindings.push({
              bindingName: binding.name,
              requestKey,
            });

            // Bind placeholder; actual result arrives after provisioning.
            env[binding.name] = null;

            // Only schedule once per round; bindings still get filled from PlanningStore.
            if (!roundRequestKeys.has(requestKey)) {
              roundRequestKeys.add(requestKey);
              requestsToExecute.push({
                request: {
                  capName: binding.value.capName,
                  argsJson: argsValue,
                  timeoutMs: config.capTimeoutMs,
                },
                requestKey,
              });
            }

            continue;
          }

          // Non-do binding is computed immediately.
          const value = evalExprAtPlanTime(binding.value, eloInput, env);
          env[binding.name] = value;
        }

        // Provision after round (batch-at-end)
        if (requestsToExecute.length > 0) {
          const responses = await executor.executeBatch(
            requestsToExecute,
            capContext,
            effectivePlanningStore,
          );

          if (opts.includeDebug) {
            for (let i = 0; i < requestsToExecute.length; i++) {
              const req = requestsToExecute[i]!;
              const res = responses[i]!;
              provisioningOutcomes.set(req.requestKey, res);
            }
          }
        }

        // Consume results into env for next `then`
        for (const doBinding of pendingRoundDoBindings) {
          const v = effectivePlanningStore.get(doBinding.requestKey);
          env[doBinding.bindingName] = v === undefined ? null : v;
        }
      }

      // Score execution: compile a wrapper so score can reference round bindings.
      const scoreValue = evalExprAtPlanTime(program.score, eloInput, env);

      return typeof scoreValue === "number" ? scoreValue : 0.0;
    };

    const scoreValue = await withTimeout(main(), config.eloPluginTimeoutMs);

    const elapsedMs = Date.now() - startTime;
    const numericScore = typeof scoreValue === "number" ? scoreValue : 0.0;
    const result: EloEvaluationResult = {
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      score: Math.max(
        0.0,
        Math.min(1.0, isFinite(numericScore) ? numericScore : 0.0),
      ),
      success: true,
      elapsedMs,
    };

    const debug = buildDebugPlan(
      plugin.manifest.name,
      opts.includeDebug ? plannedDecls : [],
      opts.includeDebug ? provisioningOutcomes : new Map(),
      true,
      result.score,
      elapsedMs,
    );

    return { result, debug };
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    logger.error(`Plugin ${plugin.manifest.name} failed: ${errorMsg}`);

    const result: EloEvaluationResult = {
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      score: 0.0,
      success: false,
      error: errorMsg,
      elapsedMs,
    };

    const debug = buildDebugPlan(
      plugin.manifest.name,
      opts.includeDebug ? plannedDecls : [],
      opts.includeDebug ? provisioningOutcomes : new Map(),
      false,
      0.0,
      elapsedMs,
    );

    return { result, debug };
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
  } & HostPolicyLimits,
): Promise<Record<string, number>> {
  const metrics: Record<string, number> = {};

  if (plugins.length === 0) {
    return metrics;
  }

  logger.debug(
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

  logger.debug(`Completed running ${plugins.length} plugins`);

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
  } & HostPolicyLimits,
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
