import type {
  NostrProfile,
  ProfileMetrics,
  DataStoreKey,
  MetricWeights,
} from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import { withTimeout } from "@/utils";
import {
  WeightProfileManager,
  type CoverageValidationResult,
} from "./weight-profiles";
import {
  ValidationRegistry,
  type ValidationContext,
  ALL_PLUGINS,
  type ValidationPlugin,
} from "./plugins";
import type { DataStore } from "@/database/data-store";
import type { RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-social-graph";

/**
 * Consolidated validator class for all profile metrics
 * Implements NIP-05, Lightning, Event, and Reciprocity validations
 */
export class MetricsValidator {
  private pool: RelayPool;
  private nostrRelays: string[];
  private graphManager: SocialGraph;
  private dataStore: DataStore<ProfileMetrics>;
  private timeoutMs: number = 10000;
  private registry: ValidationRegistry;
  private weightProfileManager: WeightProfileManager;

  /**
   * Create a new MetricsValidator instance
   * @param pool - Shared RelayPool instance for Nostr operations
   * @param nostrRelays - Array of Nostr relay URLs
   * @param graphManager - SocialGraph instance for reciprocity checks
   * @param dataStore - Cache instance for storing profile metrics
   * @param plugins - Array of validation plugins to register (defaults to all available plugins)
   * @param weightProfileManager - Optional weight profile manager
   */
  constructor(
    pool: RelayPool,
    nostrRelays: string[],
    graphManager: SocialGraph,
    dataStore: DataStore<ProfileMetrics>,
    plugins: ValidationPlugin[] = ALL_PLUGINS,
    weightProfileManager?: WeightProfileManager,
  ) {
    if (!pool) {
      throw new ValidationError("RelayPool instance is required");
    }

    if (!nostrRelays || nostrRelays.length === 0) {
      throw new ValidationError("Nostr relays array cannot be empty");
    }

    if (!graphManager) {
      throw new ValidationError("SocialGraph instance is required");
    }

    if (!dataStore) {
      throw new ValidationError("Cache instance is required");
    }

    this.pool = pool;
    this.nostrRelays = nostrRelays;
    this.graphManager = graphManager;
    this.dataStore = dataStore;

    // Initialize weight profile manager
    this.weightProfileManager =
      weightProfileManager || new WeightProfileManager();

    // Create registry with weight profile manager
    this.registry = new ValidationRegistry(this.weightProfileManager);

    // Register provided plugins
    for (const plugin of plugins) {
      this.registry.register(plugin);
    }
  }

  /**
   * Validate all metrics for a pubkey
   * Checks cache first, then validates all registered plugins if not cached
   * @param pubkey - Target public key to validate
   * @param sourcePubkey - Optional source pubkey for reciprocity validation
   * @param searchQuery - Optional search query for context-aware validations
   * @returns Complete ProfileMetrics object with all validation results
   */
  async validateAll(
    pubkey: string,
    sourcePubkey?: string,
    searchQuery?: string,
  ): Promise<ProfileMetrics> {
    if (!pubkey || typeof pubkey !== "string") {
      throw new ValidationError("Pubkey must be a non-empty string");
    }

    const dataStoreKey: DataStoreKey = sourcePubkey
      ? [pubkey, sourcePubkey]
      : pubkey;

    try {
      // Check cache first
      const cached = await this.dataStore.get(dataStoreKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      // Cache error shouldn't prevent validation
      console.warn("Cache read failed, proceeding with validation:", error);
    }

    const now = Math.floor(Date.now() / 1000);

    try {
      // Get profile for validations
      const profile = await this.fetchProfile(pubkey);

      // Create validation context
      const context: ValidationContext = {
        pubkey,
        sourcePubkey,
        searchQuery,
        profile,
        graphManager: this.graphManager,
        pool: this.pool,
        relays: this.nostrRelays,
      };

      // Execute all registered plugins
      const metrics = await this.registry.executeAll(context);

      const result: ProfileMetrics = {
        pubkey,
        metrics,
        computedAt: now,
      };

      // Cache the results
      try {
        await this.dataStore.set(dataStoreKey, result);
      } catch (error) {
        // Cache error shouldn't prevent returning results
        console.warn("Cache write failed:", error);
      }

      return result;
    } catch (error) {
      // Return a default metrics object on validation errors
      const errorMetrics: ProfileMetrics = {
        pubkey,
        metrics: {},
        computedAt: now,
      };

      return errorMetrics;
    }
  }

  /**
   * Register a custom validation plugin
   * @param plugin - Validation plugin to register
   */
  registerPlugin(plugin: ValidationPlugin): void {
    this.registry.register(plugin);
  }

  /**
   * Get all registered validation plugins
   * @returns Array of registered plugins
   */
  getRegisteredPlugins(): ValidationPlugin[] {
    return this.registry.getAll();
  }

  /**
   * Get weights for all registered validation plugins
   * @returns Record of plugin weights
   */
  getPluginWeights(): Record<string, number> {
    return this.registry.getWeights();
  }

  /**
   * Get the weight profile manager
   * @returns WeightProfileManager instance
   */
  getWeightProfileManager(): WeightProfileManager {
    return this.weightProfileManager;
  }

  /**
   * Activate a weight profile by name
   * @param profileName - Name of the profile to activate
   */
  activateWeightProfile(profileName: string): void {
    this.weightProfileManager.activateProfile(profileName);
  }

  /**
   * Get all weights from the active profile
   * @returns MetricWeights object with all current weights
   */
  getWeights(): MetricWeights {
    return this.weightProfileManager.getAllWeights();
  }

  /**
   * Validate coverage between registered plugins and active profile weights
   * @returns Coverage validation result
   */
  validateCoverage(): CoverageValidationResult {
    return this.registry.validateCoverage();
  }

  /**
   * Fetch Nostr profile from relays
   * @param pubkey - Public key to fetch profile for
   * @returns Nostr profile object
   */
  private async fetchProfile(pubkey: string): Promise<NostrProfile> {
    try {
      const event = await new Promise<NostrEvent | null>((resolve, reject) => {
        const subscription = this.pool
          .request(
            this.nostrRelays,
            {
              kinds: [0], // Metadata event
              authors: [pubkey],
              limit: 1,
            },
            {
              retries: 1,
            },
          )
          .subscribe({
            next: (event) => {
              resolve(event);
              subscription.unsubscribe();
            },
            error: (error) => {
              reject(error);
            },
          });

        // Auto-unsubscribe after timeout to prevent hanging subscriptions
        setTimeout(() => {
          subscription.unsubscribe();
          resolve(null);
        }, this.timeoutMs);
      });

      if (!event || !event.content) {
        return { pubkey };
      }

      // Parse profile content with error handling
      try {
        const profile = JSON.parse(event.content) as Partial<NostrProfile>;
        return {
          pubkey,
          name: profile.name,
          display_name: profile.display_name,
          picture: profile.picture,
          nip05: profile.nip05,
          lud16: profile.lud16,
          about: profile.about,
        };
      } catch {
        // Return minimal profile on parse error
        return { pubkey };
      }
    } catch (error) {
      // Return minimal profile on error
      return { pubkey };
    }
  }
}
