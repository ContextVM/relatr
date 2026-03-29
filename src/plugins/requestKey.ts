import { canonicalizeArgs } from "./jsonBoundary";

/**
 * Generate a stable RequestKey for a capability request.
 * RequestKey = capName + "\n" + canonicalArgsJson
 *
 * @param capName - The dotted capability name
 * @param argsJson - The JSON-compatible arguments
 * @returns A stable, unique request key, or null if args are not strict JSON
 */
export function generateRequestKey(
  capName: string,
  argsJson: unknown,
): string | null {
  // Validate JSON-only and canonicalize in one step
  const canonicalArgs = canonicalizeArgs(argsJson);
  if (canonicalArgs === null) {
    return null;
  }

  return `${capName}\n${canonicalArgs}`;
}
