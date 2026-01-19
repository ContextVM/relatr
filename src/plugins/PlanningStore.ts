import { canonicalize } from "json-canonicalize";

/**
 * PlanningStore - Temporary in-memory store for capability results during evaluation
 *
 * This store is used during the planning phase of Elo plugin evaluation to avoid
 * redundant capability calls within a single evaluation. It is created at the start
 * of evaluation and flushed after completion.
 *
 * Key characteristics:
 * - Scope: Single evaluation only (not persisted across evaluations)
 * - Lifecycle: Created at start, flushed after completion
 * - Key format: pluginId:targetPubkey:capName:argsHash
 * - Purpose: Deduplicate capability requests across plugins during planning
 *
 * This is NOT a cache with TTL. When metrics expire in MetricsRepository,
 * the planning store is already empty, ensuring fresh capability results on recomputation.
 */
export class PlanningStore {
  private store = new Map<string, unknown>();

  /**
   * Generate a cache key for a capability request
   * @param pluginId - The plugin ID
   * @param targetPubkey - The target pubkey
   * @param capName - The capability name
   * @param args - The capability arguments
   * @returns A deterministic cache key
   */
  private generateKey(
    pluginId: string,
    targetPubkey: string,
    capName: string,
    args: string[],
  ): string {
    // Use json-canonicalize for deterministic serialization
    // This ensures that objects with the same keys/values in different orders produce the same hash
    const argsHash = args.length > 0 ? canonicalize(args) : "[]";
    return `${pluginId}:${targetPubkey}:${capName}:${argsHash}`;
  }

  /**
   * Check if a capability result exists in the store
   * @param pluginId - The plugin ID
   * @param targetPubkey - The target pubkey
   * @param capName - The capability name
   * @param args - The capability arguments
   * @returns true if the result exists
   */
  has(
    pluginId: string,
    targetPubkey: string,
    capName: string,
    args: string[],
  ): boolean {
    const key = this.generateKey(pluginId, targetPubkey, capName, args);
    return this.store.has(key);
  }

  /**
   * Get a capability result from the store
   * @param pluginId - The plugin ID
   * @param targetPubkey - The target pubkey
   * @param capName - The capability name
   * @param args - The capability arguments
   * @returns The stored result, or undefined if not found
   */
  get(
    pluginId: string,
    targetPubkey: string,
    capName: string,
    args: string[],
  ): unknown {
    const key = this.generateKey(pluginId, targetPubkey, capName, args);
    return this.store.get(key);
  }

  /**
   * Store a capability result
   * @param pluginId - The plugin ID
   * @param targetPubkey - The target pubkey
   * @param capName - The capability name
   * @param args - The capability arguments
   * @param value - The result value to store
   */
  set(
    pluginId: string,
    targetPubkey: string,
    capName: string,
    args: string[],
    value: unknown,
  ): void {
    const key = this.generateKey(pluginId, targetPubkey, capName, args);
    this.store.set(key, value);
  }

  /**
   * Clear all entries from the store
   * Called after evaluation completes to prevent memory leaks
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of entries in the store
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Get all entries as an array of keys
   * Useful for debugging and testing
   */
  getKeys(): string[] {
    return Array.from(this.store.keys());
  }
}
