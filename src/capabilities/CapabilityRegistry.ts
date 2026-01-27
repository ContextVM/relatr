import { Logger } from "../utils/Logger";
import type { BaseContext } from "../plugins/plugin-types";

const logger = new Logger({ service: "CapabilityRegistry" });

/**
 * Capability handler function signature
 */
export type CapabilityHandler = (
  args: unknown,
  context: CapabilityContext,
) => Promise<unknown>;

/**
 * Context passed to capability handlers
 */
export interface CapabilityContext extends BaseContext {
  config: {
    capTimeoutMs: number;
  };
}

/**
 * Registry for managing available capabilities
 *
 * This registry only stores capability handlers. Enablement policy is managed
 * by the CapabilityExecutor, which uses the capability catalog and environment
 * variables to determine which capabilities are enabled.
 */
export class CapabilityRegistry {
  private handlers = new Map<string, CapabilityHandler>();

  constructor() {
    logger.debug("CapabilityRegistry initialized");
  }

  /**
   * Register a capability handler
   * @param name - Capability name (e.g., "nostr.query")
   * @param handler - Function to handle the capability
   */
  register(name: string, handler: CapabilityHandler): void {
    this.handlers.set(name, handler);
    logger.debug(`Registered capability: ${name}`);
  }

  /**
   * Get handler for a capability
   * @param name - Capability name
   * @returns Handler function or undefined
   */
  getHandler(name: string): CapabilityHandler | undefined {
    return this.handlers.get(name);
  }

  /**
   * List all registered capabilities
   * @returns Array of capability names
   */
  listCapabilities(): string[] {
    return Array.from(this.handlers.keys());
  }
}
