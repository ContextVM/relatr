/**
 * Registry for metric descriptions that provides human-readable explanations
 * for both TS validators and Elo plugin metrics.
 *
 * Descriptions are loaded once at startup and remain static throughout
 * the application lifecycle.
 */
export class MetricDescriptionRegistry {
  private descriptions = new Map<string, string>();

  /**
   * Register a metric description
   * @param metricName - The unique name of the metric (e.g., 'nip05', 'elo-example')
   * @param description - Human-readable description of what the metric measures
   */
  register(metricName: string, description: string): void {
    this.descriptions.set(metricName, description);
  }

  /**
   * Get the description for a specific metric
   * @param metricName - The metric name to look up
   * @returns The description string, or undefined if not found
   */
  get(metricName: string): string | undefined {
    return this.descriptions.get(metricName);
  }

  /**
   * Get all registered metric descriptions as a record
   * @returns Object mapping metric names to their descriptions
   */
  getAll(): Record<string, string> {
    return Object.fromEntries(this.descriptions);
  }

  /**
   * Check if a metric has a registered description
   * @param metricName - The metric name to check
   * @returns true if the metric has a description
   */
  has(metricName: string): boolean {
    return this.descriptions.has(metricName);
  }

  /**
   * Get the total number of registered metric descriptions
   * @returns The count of registered metrics
   */
  get size(): number {
    return this.descriptions.size;
  }
}
