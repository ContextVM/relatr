import { canonicalize } from "json-canonicalize";

/**
 * Check if a value is strict JSON (no undefined, functions, BigInt, etc.)
 * Returns true if valid JSON, false otherwise.
 */
export function isJsonValue(value: unknown): boolean {
  // Explicitly reject non-JSON types
  if (value === undefined) {
    return false;
  }
  if (typeof value === "function") {
    return false;
  }
  if (typeof value === "symbol") {
    return false;
  }
  // BigInt is not JSON-serializable
  if (typeof value === "bigint") {
    return false;
  }
  // NaN and Infinity are not JSON
  if (typeof value === "number" && (!isFinite(value) || isNaN(value))) {
    return false;
  }

  try {
    // This will throw if given non-JSON values
    const canonical = canonicalize(value as Parameters<typeof canonicalize>);
    return canonical !== undefined;
  } catch {
    return false;
  }
}

/**
 * Validate and canonicalize args for RequestKey generation.
 * Returns canonicalized JSON string if valid, null otherwise.
 */
export function canonicalizeArgs(args: unknown): string | null {
  if (!isJsonValue(args)) {
    return null;
  }

  try {
    const canonical = canonicalize(args as Parameters<typeof canonicalize>);
    if (canonical === undefined) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}
