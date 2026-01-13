import type {
  CapabilityRequest,
  CapabilityResponse,
} from "../plugins/plugin-types";
import type {
  CapabilityRegistry,
  CapabilityContext,
} from "./CapabilityRegistry";
import { CAPABILITY_CATALOG } from "./capability-catalog";
import { createHash } from "crypto";
import { Logger } from "../utils/Logger";
import { withTimeout } from "../utils/utils";

const logger = new Logger({ service: "CapabilityExecutor" });

/**
 * Cache entry for capability results
 */
interface CacheEntry {
  value: unknown;
  timestamp: number;
}

/**
 * Executes capabilities with timeouts, caching, and error handling
 *
 * The executor owns the enablement policy for capabilities, using the
 * capability catalog and environment variables to determine which capabilities
 * are enabled. Runtime overrides can be applied for testing purposes.
 */
export class CapabilityExecutor {
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private disabledCaps = new Set<string>();
  private runtimeOverrides = new Map<string, boolean>();

  constructor(
    private registry: CapabilityRegistry,
    cacheTtlHours: number = 72,
  ) {
    this.cacheTtlMs = cacheTtlHours * 60 * 60 * 1000;
    this.initializeFromEnv();
  }

  /**
   * Initialize capability enablement from environment variables
   */
  private initializeFromEnv(): void {
    for (const cap of CAPABILITY_CATALOG) {
      const envValue = process.env[cap.envVar];
      const enabled = envValue === undefined || envValue === "true"; // Default to enabled if not set, disabled if explicitly "false"

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
   * Generate a cache key for a capability request
   * Format: pluginId:targetPubkey:capName:capArgsHash
   */
  private generateCacheKey(
    pluginId: string,
    targetPubkey: string,
    request: CapabilityRequest,
  ): string {
    // Create hash of capability arguments
    const argsString = [request.capName, ...request.args].join("\n");
    const argsHash = createHash("sha256")
      .update(argsString)
      .digest("hex")
      .substring(0, 16);

    return `${pluginId}:${targetPubkey}:${request.capName}:${argsHash}`;
  }

  /**
   * Check if a cache entry is still valid
   */
  private isCacheValid(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp < this.cacheTtlMs;
  }

  /**
   * Execute a capability with caching and timeout
   * @param request - Capability request
   * @param context - Execution context
   * @param pluginId - Plugin ID for caching
   * @returns Capability response
   */
  async execute(
    request: CapabilityRequest,
    context: CapabilityContext,
    pluginId: string,
  ): Promise<CapabilityResponse> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(
      pluginId,
      context.targetPubkey,
      request,
    );

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      logger.debug(`Cache hit for ${request.capName}`);
      return {
        ok: true,
        value: cached.value,
        error: null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Check if capability is enabled
    if (!this.isEnabled(request.capName)) {
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
        handler(request.args, context),
        timeoutMs,
      );

      // Cache the result
      this.cache.set(cacheKey, {
        value,
        timestamp: Date.now(),
      });

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
   * @param pluginId - Plugin ID for caching
   * @returns Array of capability responses
   */
  async executeBatch(
    requests: CapabilityRequest[],
    context: CapabilityContext,
    pluginId: string,
  ): Promise<CapabilityResponse[]> {
    const promises = requests.map((request) =>
      this.execute(request, context, pluginId),
    );

    return Promise.all(promises);
  }

  /**
   * Clear the capability cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info("Capability cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; ttlHours: number } {
    return {
      size: this.cache.size,
      ttlHours: this.cacheTtlMs / (60 * 60 * 1000),
    };
  }
}
