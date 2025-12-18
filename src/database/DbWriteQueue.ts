/**
 * Single-process, single-connection write serialization for DuckDB.
 *
 * Why:
 * - A DuckDBConnection has a single transaction context.
 * - Our app shares one connection across async tasks (scheduler + request path).
 * - Concurrent writes / overlapping BEGIN TRANSACTION blocks cause:
 *   - "cannot start a transaction within a transaction"
 *   - "Current transaction is aborted (please ROLLBACK)"
 *
 * This queue provides a tiny "mutex" by chaining promises (FIFO).
 * It is intentionally process-local (not cross-process).
 */
export class DbWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run a function exclusively. Calls are serialized in the order they are scheduled.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;

    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Global write queue instance used by repositories/services that share the primary DuckDB connection.
 */
export const dbWriteQueue = new DbWriteQueue();
