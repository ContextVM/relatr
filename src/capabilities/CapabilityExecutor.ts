import type {
  CapabilityRequest,
  CapabilityResponse,
} from "../plugins/plugin-types";
import type {
  CapabilityRegistry,
  CapabilityContext,
} from "./CapabilityRegistry";
import { createHash } from "crypto";
import { Logger } from "../utils/Logger";
import { withTimeout } from "../utils/utils";

const logger = new Logger({ service: "CapabilityExecutor" });

/**
 * Cache entry for capability results
 */
interface CacheEntry {
  value: any;
  timestamp: number;
}

/**
 * Executes capabilities with timeouts, caching, and error handling
 */
export class CapabilityExecutor {
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;

  constructor(
    private registry: CapabilityRegistry,
    cacheTtlHours: number = 72,
  ) {
    this.cacheTtlMs = cacheTtlHours * 60 * 60 * 1000;
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
    if (!this.registry.isEnabled(request.capName)) {
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
      const result = await withTimeout(
        handler(request.args, context),
        timeoutMs,
      );

      // Cache the result
      this.cache.set(cacheKey, {
        value: result,
        timestamp: Date.now(),
      });

      logger.debug(`Capability ${request.capName} executed successfully`);

      return {
        ok: true,
        value: result,
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
