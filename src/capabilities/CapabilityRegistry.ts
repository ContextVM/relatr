import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "CapabilityRegistry" });

/**
 * Capability handler function signature
 */
export type CapabilityHandler = (
  args: string[],
  context: CapabilityContext,
) => Promise<any>;

/**
 * Context passed to capability handlers
 */
export interface CapabilityContext {
  targetPubkey: string;
  sourcePubkey?: string;
  config: {
    capTimeoutMs: number;
  };
}

/**
 * Registry for managing available capabilities
 */
export class CapabilityRegistry {
  private handlers = new Map<string, CapabilityHandler>();
  private enabledCaps = new Set<string>();
  private disabledCaps = new Set<string>();

  constructor() {
    // Initialize with default enabled state from env
    this.initializeFromEnv();
  }

  /**
   * Initialize capability enablement from environment variables
   */
  private initializeFromEnv(): void {
    const capNames = [
      "nostr.query",
      "graph.stats",
      "graph.all_pubkeys",
      "graph.pubkey_exists",
      "graph.is_following",
      "graph.are_mutual",
      "graph.degree",
      "http.nip05_resolve",
    ];

    for (const capName of capNames) {
      const envVar = `ENABLE_CAP_${capName.replace(/\./g, "_").toUpperCase()}`;
      const envValue = process.env[envVar];
      const enabled = envValue === undefined || envValue === "true"; // Default to enabled if not set, disabled if explicitly "false"

      if (enabled) {
        this.enabledCaps.add(capName);
      } else {
        this.disabledCaps.add(capName);
      }
    }

    logger.info(
      `Capabilities enabled: ${Array.from(this.enabledCaps).join(", ")}`,
    );
  }

  /**
   * Register a capability handler
   * @param name - Capability name (e.g., "nostr.query")
   * @param handler - Function to handle the capability
   */
  register(name: string, handler: CapabilityHandler): void {
    this.handlers.set(name, handler);
    // Only enable if not explicitly disabled by env var
    if (!this.disabledCaps.has(name)) {
      this.enabledCaps.add(name);
    }
    logger.debug(`Registered capability: ${name}`);
  }

  /**
   * Check if a capability is enabled
   * @param name - Capability name
   * @returns True if enabled
   */
  isEnabled(name: string): boolean {
    // A capability is enabled if it's registered and not explicitly disabled
    return this.handlers.has(name) && !this.disabledCaps.has(name);
  }

  /**
   * Enable or disable a capability
   * @param name - Capability name
   * @param enabled - Whether to enable
   */
  setEnabled(name: string, enabled: boolean): void {
    if (enabled) {
      this.enabledCaps.add(name);
      this.disabledCaps.delete(name);
    } else {
      this.enabledCaps.delete(name);
      this.disabledCaps.add(name);
    }
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

  /**
   * List all enabled capabilities
   * @returns Array of enabled capability names
   */
  listEnabledCapabilities(): string[] {
    return Array.from(this.enabledCaps);
  }
}
