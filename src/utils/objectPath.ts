/**
 * Utility functions for working with object paths
 */

/**
 * Set a nested value in an object using dot notation
 * @param obj - The object to modify
 * @param path - The dot-notation path (e.g., "http.nip05_resolve.pubkey")
 * @param value - The value to set
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
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
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    current[lastPart] = value;
  }
}

/**
 * Get a nested value from an object using dot notation
 * @param obj - The object to query
 * @param path - The dot-notation path (e.g., "http.nip05_resolve.pubkey")
 * @returns The value at the path, or undefined if not found
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  // Filter out empty path segments and check if path is effectively empty
  const parts = path.split(".").filter((p) => p.length > 0);

  // If path is empty or only contains empty segments, return undefined
  if (parts.length === 0) {
    return undefined;
  }

  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
