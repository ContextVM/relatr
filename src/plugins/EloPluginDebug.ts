import type { CapabilityResponse } from "./plugin-types";
import type { PluginManifest } from "./plugin-types";

/**
 * Debug plan output for Elo plugin evaluation.
 * Provides transparency into what the system planned and provisioned.
 */
export interface EloPluginDebugPlan {
  /** Plugin name for identification */
  pluginName: string;

  /**
   * Planned declarations from plugin execution.
   * Contains the do-call bindings with their request keys for traceability.
   */
  plannedDecls: {
    bindingName: string;
    capName: string;
    requestKey: string | null; // null if unplannable
    roundIndex?: number;
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
  plannedDecls: EloPluginDebugPlan["plannedDecls"],
  provisioningOutcomes: Map<string, CapabilityResponse>,
  scoringSuccess: boolean,
  score: number,
  elapsedMs: number,
): EloPluginDebugPlan {
  const uniqueRequestKeys = new Set<string>();

  for (const decl of plannedDecls) {
    if (decl.requestKey) uniqueRequestKeys.add(decl.requestKey);
  }

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
