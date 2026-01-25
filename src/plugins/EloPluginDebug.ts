import type { PlanRelatrResult } from "./relatrPlanner";
import type { CapabilityResponse } from "./plugin-types";
import type { PluginManifest } from "./plugin-types";

/**
 * Debug plan output for Elo plugin evaluation.
 * Provides transparency into what the system planned and provisioned.
 */
export interface EloPluginDebugPlan {
  /** Plugin name for identification */
  pluginName: string;

  /** Planned capability declarations with their ids and RequestKeys */
  plannedDecls: {
    id: string;
    capName: string;
    requestKey: string | null; // null if unplannable
  }[];

  /** Set of unique RequestKeys that were provisioned */
  uniqueRequestKeys: string[];

  /** Provisioning outcomes keyed by RequestKey */
  provisioningOutcomes: Record<
    string,
    {
      ok: boolean;
      value: unknown;
      error: string | null;
    }
  >;

  /** Whether scoring succeeded */
  scoringSuccess: boolean;

  /** Final score */
  score: number;

  /** Evaluation time in milliseconds */
  elapsedMs: number;
}

/**
 * Build a debug plan from planning and provisioning results.
 */
export function buildDebugPlan(
  pluginName: string,
  planResult: PlanRelatrResult,
  provisioningOutcomes: Map<string, CapabilityResponse>,
  scoringSuccess: boolean,
  score: number,
  elapsedMs: number,
): EloPluginDebugPlan {
  const uniqueRequestKeys = new Set<string>();

  const plannedDecls = planResult.plannedDecls.map((decl) => {
    if (decl.requestKey) {
      uniqueRequestKeys.add(decl.requestKey);
    }
    return {
      id: decl.id,
      capName: decl.capName,
      requestKey: decl.requestKey,
    };
  });

  const outcomes: Record<
    string,
    { ok: boolean; value: unknown; error: string | null }
  > = {};
  for (const [key, response] of provisioningOutcomes) {
    outcomes[key] = {
      ok: response.ok,
      value: response.value,
      error: response.error,
    };
  }

  return {
    pluginName,
    plannedDecls,
    uniqueRequestKeys: Array.from(uniqueRequestKeys),
    provisioningOutcomes: outcomes,
    scoringSuccess,
    score,
    elapsedMs,
  };
}
