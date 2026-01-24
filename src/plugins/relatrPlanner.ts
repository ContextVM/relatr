import { compile } from "@enspirit/elo";
import { DateTime, Duration } from "luxon";
import type { EloInput } from "./plugin-types";
import { generateRequestKey } from "./requestKey";
import { Logger } from "../utils/Logger";
import { extractRelatrBlocks } from "./relatrBlocks";

const logger = new Logger({ service: "RelatrPlanner" });

export interface PlannedDecl {
  id: string;
  capName: string;
  argsExpr: string;
  requestKey: string | null;
  /**
   * Planned args value, if plannable and JSON-only; otherwise null.
   * This is what is exposed at plan-time as _.planned[id].
   */
  argsJsonOrNull: unknown | null;
}

export interface PlanRelatrResult {
  strippedSource: string;
  plannedDecls: PlannedDecl[];
}

function parseDeclLine(
  line: string,
): { id: string; capName: string; argsExpr: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("--")) return null; // allow comments inside blocks

  const m = trimmed.match(/^cap\s+([a-z0-9_-]+)\s*=\s*([a-z0-9_.-]+)\s+(.+)$/);
  if (!m) return null;
  const [, id, capName, argsExpr] = m;
  if (!id || !capName || !argsExpr) return null;
  return { id, capName, argsExpr: argsExpr.trim() };
}

/**
 * Plan RELATR declarations:
 * - Extract + strip RELATR blocks from source
 * - Parse `cap <id> = <capName> <args_expr>` declarations (single-line)
 * - Evaluate args_expr sequentially with access to _.planned
 */
export function planRelatrDeclarations(
  source: string,
  input: EloInput,
): PlanRelatrResult {
  const { strippedSource, blocks } = extractRelatrBlocks(source);

  const declsInOrder: Array<{ id: string; capName: string; argsExpr: string }> =
    [];
  const seenIds = new Set<string>();

  for (const blockText of blocks) {
    const blockLines = blockText.split(/\r?\n/);
    for (const line of blockLines) {
      const parsed = parseDeclLine(line);
      if (!parsed) continue;

      if (seenIds.has(parsed.id)) {
        logger.warn(`Duplicate RELATR cap id '${parsed.id}' ignored`);
        continue;
      }
      seenIds.add(parsed.id);
      declsInOrder.push(parsed);
    }
  }

  const plannedDecls: PlannedDecl[] = [];
  const planned: Record<string, unknown | null> = {};

  for (const decl of declsInOrder) {
    let requestKey: string | null = null;
    let argsJsonOrNull: unknown | null = null;

    try {
      // Match EloEvaluator runtime injection so planning doesn't fail for
      // runtime type checks (DateTime/Duration) even when user expressions
      // don't explicitly reference them.
      const compiledArgs = compile(decl.argsExpr, {
        runtime: { DateTime, Duration },
      }) as any;
      const planTimeInput = { ...(input as any), planned };
      const argsValue =
        typeof compiledArgs === "function"
          ? compiledArgs(planTimeInput)
          : compiledArgs && typeof compiledArgs.evaluate === "function"
            ? compiledArgs.evaluate(planTimeInput)
            : compiledArgs;

      requestKey = generateRequestKey(decl.capName, argsValue);
      if (requestKey) {
        argsJsonOrNull = argsValue as any;
      }
    } catch (error) {
      logger.warn(
        `Failed to plan RELATR declaration '${decl.id}' (${decl.capName}): ${error}`,
      );
    }

    planned[decl.id] = requestKey ? (argsJsonOrNull as any) : null;

    plannedDecls.push({
      id: decl.id,
      capName: decl.capName,
      argsExpr: decl.argsExpr,
      requestKey,
      argsJsonOrNull: requestKey ? (argsJsonOrNull as any) : null,
    });
  }

  return { strippedSource, plannedDecls };
}
