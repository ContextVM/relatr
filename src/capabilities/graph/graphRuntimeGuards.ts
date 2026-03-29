import type { SocialGraph } from "@/graph/SocialGraph";

import type { CapabilityContext } from "../CapabilityRegistry";

type GraphArgObject = Record<string, unknown>;

function isArgObject(args: unknown): args is GraphArgObject {
  return !!args && typeof args === "object" && !Array.isArray(args);
}

export function requireGraph(context: CapabilityContext): SocialGraph {
  if (!context.graph) {
    throw new Error("SocialGraph not available in context");
  }

  return context.graph;
}

export function readRequiredStringArg(
  capabilityName: string,
  args: unknown,
  fieldName: string,
): string {
  if (!isArgObject(args) || typeof args[fieldName] !== "string") {
    throw new Error(
      `${capabilityName} requires a string '${fieldName}' field in the arguments object`,
    );
  }

  return args[fieldName];
}

export function readRequiredNonNegativeNumberArg(
  capabilityName: string,
  args: unknown,
  fieldName: string,
): number {
  if (!isArgObject(args) || typeof args[fieldName] !== "number") {
    throw new Error(
      `${capabilityName} requires a non-negative numeric '${fieldName}' field in the arguments object`,
    );
  }

  const value = args[fieldName];
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${capabilityName} requires a non-negative numeric '${fieldName}' field in the arguments object`,
    );
  }

  return value;
}
