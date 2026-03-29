import type {
  CapabilityRequest,
  CapabilityResponse,
} from "../plugins/plugin-types";
import type {
  CapabilityRegistry,
  CapabilityContext,
} from "./CapabilityRegistry";
import { CAPABILITY_CATALOG } from "./capability-catalog";
import { Logger } from "../utils/Logger";
import { withTimeout } from "../utils/utils";
import type { PlanningStore } from "../plugins/PlanningStore";

const logger = new Logger({ service: "CapabilityExecutor" });

/**
 * Executes capabilities with timeouts and error handling
 *
 * The executor owns the enablement policy for capabilities, using the
 * capability catalog and environment variables to determine which capabilities
 * are enabled. Runtime overrides can be applied for testing purposes.
 *
 * Note: This executor uses a per-evaluation planning store for deduplication
 * within a single plugin evaluation, but does NOT cache results across evaluations.
 * This ensures fresh capability results when metrics are recomputed.
 */
export class CapabilityExecutor {
  private disabledCaps = new Set<string>();
  private runtimeOverrides = new Map<string, boolean>();

  constructor(private registry: CapabilityRegistry) {
    this.initializeFromEnv();
  }

  /**
   * Initialize capability enablement from environment variables
   */
  private initializeFromEnv(): void {
    for (const cap of CAPABILITY_CATALOG) {
      const envValue = process.env[cap.envVar];
      // If env var is set, use its value (explicit override)
      // Otherwise, use the defaultEnabled from the catalog
      const enabled =
        envValue !== undefined ? envValue === "true" : cap.defaultEnabled;

      if (!enabled) {
        this.disabledCaps.add(cap.name);
      }
    }

    const enabledCount = CAPABILITY_CATALOG.length - this.disabledCaps.size;
    logger.info(
      `Capabilities enabled: ${enabledCount}/${CAPABILITY_CATALOG.length}`,
    );
  }

  /**
   * Execute a capability with timeout and error handling
   * @param request - Capability request
   * @param context - Execution context
   * @param pluginId - Plugin ID for deduplication
   * @param planningStore - Optional planning store for per-evaluation deduplication
   * @returns Capability response
   */
  async execute(
    request: CapabilityRequest,
    context: CapabilityContext,
    planningStore?: PlanningStore,
    requestKey?: string,
  ): Promise<CapabilityResponse> {
    const startTime = Date.now();

    // Check planning store first (if provided) - this is per-evaluation deduplication
    if (planningStore && requestKey) {
      const planningResult = planningStore.get(requestKey);
      if (planningResult !== undefined) {
        logger.debug(`Planning store hit for ${request.capName}`);
        return {
          ok: true,
          value: planningResult,
          error: null,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    // Check if capability is enabled
    if (!this.isEnabled(request.capName)) {
      // Cache failures as null within this evaluation so repeated requests
      // dedupe correctly (v1 failure semantics => null).
      if (planningStore && requestKey) {
        planningStore.set(requestKey, null);
      }
      return {
        ok: false,
        value: null,
        error: `Capability '${request.capName}' is disabled`,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Get handler
    const handler = this.registry.getHandler(request.capName);
    if (!handler) {
      // Cache failures as null within this evaluation so repeated requests
      // dedupe correctly (v1 failure semantics => null).
      if (planningStore && requestKey) {
        planningStore.set(requestKey, null);
      }
      return {
        ok: false,
        value: null,
        error: `Unknown capability: ${request.capName}`,
        elapsedMs: Date.now() - startTime,
      };
    }

    try {
      // Execute with timeout
      const timeoutMs = request.timeoutMs || context.config.capTimeoutMs;
      const value = await withTimeout(
        handler(request.argsJson, context),
        timeoutMs,
      );

      // Store in planning store if provided (for deduplication within evaluation)
      if (planningStore && requestKey) {
        planningStore.set(requestKey, value);
      }

      logger.debug(`Capability ${request.capName} executed successfully`);

      return {
        ok: true,
        value,
        error: null,
        elapsedMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Capability ${request.capName} failed: ${errorMsg}`);

      // Cache failures as null within this evaluation so repeated requests
      // dedupe correctly (v1 failure semantics => null).
      if (planningStore && requestKey) {
        planningStore.set(requestKey, null);
      }

      return {
        ok: false,
        value: null,
        error: errorMsg,
        elapsedMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if a capability is enabled
   * @param name - Capability name
   * @returns True if enabled
   */
  isEnabled(name: string): boolean {
    // Check runtime override first
    const override = this.runtimeOverrides.get(name);
    if (override !== undefined) {
      return override;
    }

    // For catalog capabilities, check disabled set
    const isCatalogCap = CAPABILITY_CATALOG.some((cap) => cap.name === name);
    if (isCatalogCap) {
      return !this.disabledCaps.has(name);
    }

    // Non-catalog capabilities (e.g., test mocks) are always enabled if registered
    return this.registry.getHandler(name) !== undefined;
  }

  /**
   * Enable or disable a capability (for testing purposes)
   * @param name - Capability name
   * @param enabled - Whether to enable
   */
  setEnabledForTesting(name: string, enabled: boolean): void {
    this.runtimeOverrides.set(name, enabled);
    logger.debug(`Capability ${name} override set to: ${enabled}`);
  }

  /**
   * Clear all runtime enablement overrides (for testing)
   */
  clearTestingOverrides(): void {
    this.runtimeOverrides.clear();
    logger.debug("Cleared all capability enablement overrides");
  }

  /**
   * Execute multiple capabilities concurrently
   * @param requests - Array of capability requests
   * @param context - Execution context
   * @param planningStore - Optional planning store for per-evaluation deduplication
   * @returns Array of capability responses
   */
  async executeBatch(
    requests: Array<{ request: CapabilityRequest; requestKey: string }>,
    context: CapabilityContext,
    planningStore?: PlanningStore,
  ): Promise<CapabilityResponse[]> {
    const promises = requests.map(({ request, requestKey }) =>
      this.execute(request, context, planningStore, requestKey),
    );

    return Promise.all(promises);
  }
}
