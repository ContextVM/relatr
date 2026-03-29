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
 * - Key format: RequestKey (capName + "\n" + canonicalArgsJson)
 * - Purpose: Deduplicate capability requests across all plugins during planning
 */
export class PlanningStore {
  private store = new Map<string, unknown>();

  /**
   * Check if a capability result exists in the store
   * @param requestKey - The RequestKey
   * @returns true if the result exists
   */
  has(requestKey: string): boolean {
    return this.store.has(requestKey);
  }

  /**
   * Get a capability result from the store
   * @param requestKey - The RequestKey
   * @returns The stored result, or undefined if not found
   */
  get(requestKey: string): unknown {
    return this.store.get(requestKey);
  }

  /**
   * Store a capability result
   * @param requestKey - The RequestKey
   * @param value - The result value to store
   */
  set(requestKey: string, value: unknown): void {
    this.store.set(requestKey, value);
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

  /**
   * Get all entries as a record
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.store.entries());
  }
}
