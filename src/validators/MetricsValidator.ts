import { SimplePool } from "nostr-tools/pool";
import type { NostrProfile, ProfileMetrics, CacheKey } from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import { SimpleCache } from "../database/cache";
import { withTimeout } from "@/utils";
import { WeightProfileManager } from "./weight-profiles";
import {
  ValidationRegistry,
  type ValidationContext,
  Nip05Plugin,
  LightningPlugin,
  EventPlugin,
  ReciprocityPlugin,
  RootNip05Plugin,
} from "./plugins";

/**
 * Consolidated validator class for all profile metrics
 * Implements NIP-05, Lightning, Event, and Reciprocity validations
 */
export class MetricsValidator {
  private pool: SimplePool;
  private nostrRelays: string[];
  private graphManager: SocialGraph;
  private cache: SimpleCache<ProfileMetrics>;
  private timeoutMs: number = 10000;
  private registry: ValidationRegistry;
  private weightProfileManager: WeightProfileManager;

  /**
   * Create a new MetricsValidator instance
   * @param nostrRelays - Array of Nostr relay URLs
   * @param graphManager - SocialGraph instance for reciprocity checks
   * @param cache - Cache instance for storing profile metrics
   */
  constructor(
    nostrRelays: string[],
    graphManager: SocialGraph,
    cache: SimpleCache<ProfileMetrics>,
    weightProfileManager?: WeightProfileManager,
  ) {
    if (!nostrRelays || nostrRelays.length === 0) {
      throw new ValidationError("Nostr relays array cannot be empty");
    }

    if (!graphManager) {
      throw new ValidationError("SocialGraph instance is required");
    }

    if (!cache) {
      throw new ValidationError("Cache instance is required");
    }

    this.pool = new SimplePool();
    this.nostrRelays = nostrRelays;
    this.graphManager = graphManager;
    this.cache = cache;

    // Initialize weight profile manager
    this.weightProfileManager =
      weightProfileManager || new WeightProfileManager();

    // Create registry with weight profile manager
    this.registry = new ValidationRegistry(this.weightProfileManager);

    // Register default plugins
    this.registry.register(new Nip05Plugin());
    this.registry.register(new LightningPlugin());
    this.registry.register(new EventPlugin());
    this.registry.register(new ReciprocityPlugin());
    this.registry.register(new RootNip05Plugin());
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

    const cacheKey: CacheKey = sourcePubkey ? [pubkey, sourcePubkey] : pubkey;

    try {
      // Check cache first
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      // Cache error shouldn't prevent validation
      console.warn("Cache read failed, proceeding with validation:", error);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3600; // 1 hour TTL

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
        expiresAt,
      };

      // Cache the results
      try {
        await this.cache.set(cacheKey, result);
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
        expiresAt,
      };

      return errorMetrics;
    }
  }

  /**
   * Register a custom validation plugin
   * @param plugin - Validation plugin to register
   */
  registerPlugin(plugin: any): void {
    this.registry.register(plugin);
  }

  /**
   * Get all registered validation plugins
   * @returns Array of registered plugins
   */
  getRegisteredPlugins(): any[] {
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
  getWeights(): import("../types").MetricWeights {
    return this.weightProfileManager.getAllWeights();
  }

  /**
   * Validate coverage between registered plugins and active profile weights
   * @returns Coverage validation result
   */
  validateCoverage(): import("./weight-profiles").CoverageValidationResult {
    return this.registry.validateCoverage();
  }

  /**
   * Fetch Nostr profile from relays
   * @param pubkey - Public key to fetch profile for
   * @returns Nostr profile object
   */
  private async fetchProfile(pubkey: string): Promise<NostrProfile> {
    try {
      const event = await withTimeout(
        this.pool.get(this.nostrRelays, {
          kinds: [0], // Metadata event
          authors: [pubkey],
          limit: 1,
        }),
        this.timeoutMs,
      );

      if (!event || !event.content) {
        return { pubkey };
      }

      // Parse profile content
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
    } catch (error) {
      // Return minimal profile on error
      return { pubkey };
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.pool) {
      this.pool.close(this.nostrRelays);
    }
  }
}
