import type { Expr, PluginProgram } from "@contextvm/elo";
import {
  parsePluginProgram,
  compileToJavaScriptWithMeta,
  letExpr,
  functionCall,
  variable,
  memberAccess,
  dataPath,
} from "@contextvm/elo";
import { DateTime, Duration } from "luxon";
import type { EloInput } from "./plugin-types";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "RelatrPlanner" });

export type CompiledPluginProgram = {
  program: PluginProgram;
};

function runCompiled(compiled: unknown, input: unknown): unknown {
  if (typeof compiled === "function") {
    return (compiled as (_: unknown) => unknown)(input);
  }

  if (
    compiled &&
    typeof compiled === "object" &&
    "evaluate" in compiled &&
    typeof (compiled as { evaluate?: unknown }).evaluate === "function"
  ) {
    return (compiled as { evaluate: (_: unknown) => unknown }).evaluate(input);
  }

  return compiled;
}

function compileAstToFn(expr: Expr): (_: unknown) => unknown {
  const js = compileToJavaScriptWithMeta(expr, { asFunction: true });
  // The compiled code references DateTime/Duration when temporal literals/keywords are used.
  // Inject them via function scope.
  const factory = new Function(
    "DateTime",
    "Duration",
    `return ${js.code};`,
  ) as (
    DateTimeCtor: unknown,
    DurationCtor: unknown,
  ) => (_: unknown) => unknown;
  return factory(DateTime, Duration);
}

export function compilePluginProgram(source: string): CompiledPluginProgram {
  const program = parsePluginProgram(source);

  // Ensure score is compute-only (no do calls).
  if (exprContainsDoCall(program.score)) {
    throw new Error("Invalid plugin: 'do' is not permitted in score");
  }

  // Ensure 'do' only appears as the whole RHS of a binding.
  // Reject nested do-calls (e.g. inside if/object/function args) to keep planning
  // semantics simple and make failures legible.
  for (let roundIndex = 0; roundIndex < program.rounds.length; roundIndex++) {
    const round = program.rounds[roundIndex]!;
    for (const binding of round.bindings) {
      if (binding.value.type === "do_call") {
        // Also reject nested do inside args expression (a do-call must be a single request).
        if (exprContainsDoCall(binding.value.argsExpr)) {
          throw new Error(
            `Invalid plugin: nested 'do' is not permitted inside args for binding '${binding.name}' (round ${roundIndex})`,
          );
        }
        continue;
      }

      if (exprContainsDoCall(binding.value)) {
        throw new Error(
          `Invalid plugin: 'do' must be the entire value of a binding (found nested 'do' in binding '${binding.name}' in round ${roundIndex})`,
        );
      }
    }
  }

  return { program };
}

export function exprContainsDoCall(expr: Expr): boolean {
  switch (expr.type) {
    case "do_call":
      return true;

    case "literal":
    case "null":
    case "string":
    case "variable":
    case "date":
    case "datetime":
    case "duration":
    case "datapath":
      return false;

    case "temporal_keyword":
      return false;

    case "unary":
      return exprContainsDoCall(expr.operand);

    case "binary":
      return exprContainsDoCall(expr.left) || exprContainsDoCall(expr.right);

    case "member_access":
      return exprContainsDoCall(expr.object);

    case "function_call":
      return expr.args.some(exprContainsDoCall);

    case "apply":
      return exprContainsDoCall(expr.fn) || expr.args.some(exprContainsDoCall);

    case "if":
      return (
        exprContainsDoCall(expr.condition) ||
        exprContainsDoCall(expr.then) ||
        exprContainsDoCall(expr.else)
      );

    case "lambda":
      return exprContainsDoCall(expr.body);

    case "object":
      return expr.properties.some((p) => exprContainsDoCall(p.value));

    case "array":
      return expr.elements.some(exprContainsDoCall);

    case "alternative":
      return expr.alternatives.some(exprContainsDoCall);

    case "let":
      return (
        expr.bindings.some((b) => exprContainsDoCall(b.value)) ||
        exprContainsDoCall(expr.body)
      );

    case "typedef":
      return exprContainsDoCall(expr.body);

    case "guard":
      return (
        expr.constraints.some((c) => exprContainsDoCall(c.condition)) ||
        exprContainsDoCall(expr.body)
      );
  }
}

/**
 * Evaluate an Elo expression AST at plan-time with direct access to previously
 * bound plugin-program variables.
 *
 * Implementation detail:
 * Elo compilation rejects undefined variables for safety. To allow bindings,
 * we compile a wrapper `let` that defines each bound name by reading from
 * `_.__env` via `fetch`.
 */
export function evalExprAtPlanTime(
  expr: Expr,
  input: EloInput,
  env: Record<string, unknown>,
): unknown {
  const envKeys = Object.keys(env);

  if (envKeys.length === 0) {
    const fn = compileAstToFn(expr);
    return runCompiled(fn, input);
  }

  // Build an AST wrapper so we never need to serialize Expr -> code.
  // Example wrapper:
  // let a = fetch(_.__env, .a), b = fetch(_.__env, .b) in <expr>
  const envObjExpr = memberAccess(variable("_"), "__env");
  const wrappedAst = letExpr(
    envKeys.map((k) => ({
      name: k,
      value: functionCall("fetch", [envObjExpr, dataPath([k])]),
    })),
    expr,
  );

  const fn = compileAstToFn(wrappedAst);
  const planInput = {
    ...(input as unknown as Record<string, unknown>),
    __env: env,
  };
  return runCompiled(fn, planInput);
}

export function isDoCallExpr(
  expr: Expr,
): expr is Extract<Expr, { type: "do_call" }> {
  return expr.type === "do_call";
}
