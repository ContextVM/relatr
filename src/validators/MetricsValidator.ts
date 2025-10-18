import { SimplePool } from "nostr-tools/pool";
import { queryProfile } from "nostr-tools/nip05";
import type { NostrProfile, ProfileMetrics, CacheKey } from "../types";
import { ValidationError } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import { SimpleCache } from "../database/cache";

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
  }

  /**
   * Validate all metrics for a pubkey
   * Checks cache first, then validates all 4 metrics if not cached
   * @param pubkey - Target public key to validate
   * @param sourcePubkey - Optional source pubkey for reciprocity validation
   * @returns Complete ProfileMetrics object with all validation results
   */
  async validateAll(
    pubkey: string,
    sourcePubkey?: string,
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
      // Get profile for NIP-05 and Lightning validation
      const profile = await this.fetchProfile(pubkey);

      // Run all validations in parallel for better performance
      const [nip05Score, lightningScore, eventScore, reciprocityScore] =
        await Promise.all([
          this.validateNip05(profile.nip05 || "", pubkey),
          this.validateLightning(profile),
          this.validateEvent(pubkey),
          sourcePubkey
            ? this.validateReciprocity(sourcePubkey, pubkey)
            : Promise.resolve(0.0),
        ]);

      const metrics: ProfileMetrics = {
        pubkey,
        nip05Valid: nip05Score,
        lightningAddress: lightningScore,
        eventKind10002: eventScore,
        reciprocity: reciprocityScore,
        computedAt: now,
        expiresAt,
      };

      // Cache the results
      try {
        await this.cache.set(cacheKey, metrics);
      } catch (error) {
        // Cache error shouldn't prevent returning results
        console.warn("Cache write failed:", error);
      }

      return metrics;
    } catch (error) {
      // Return a default metrics object on validation errors
      const errorMetrics: ProfileMetrics = {
        pubkey,
        nip05Valid: 0.0,
        lightningAddress: 0.0,
        eventKind10002: 0.0,
        reciprocity: sourcePubkey ? 0.0 : 0.0,
        computedAt: now,
        expiresAt,
      };

      return errorMetrics;
    }
  }

  /**
   * Validate NIP-05 identifier
   * @param nip05 - NIP-05 identifier to validate
   * @param pubkey - Expected public key
   * @returns Validation score (0.0 or 1.0)
   */
  private async validateNip05(nip05: string, pubkey: string): Promise<number> {
    if (!nip05 || typeof nip05 !== "string") {
      return 0.0;
    }

    try {
      // Normalize domain-only NIP-05 (e.g., "domain.com" -> "_@domain.com")
      const normalizedNip05 = nip05.includes("@") ? nip05 : `_@${nip05}`;

      // Basic format validation
      if (!this.isValidNip05Format(normalizedNip05)) {
        return 0.0;
      }

      // Query the NIP-05 address with timeout
      const profile = await this.withTimeout(
        queryProfile(normalizedNip05),
        this.timeoutMs,
      );

      if (!profile || !profile.pubkey) {
        return 0.0;
      }

      // Verify pubkey matches
      return profile.pubkey === pubkey ? 1.0 : 0.0;
    } catch (error) {
      // Any error results in failed validation
      return 0.0;
    }
  }

  /**
   * Validate Lightning address (lud16/lud06)
   * @param profile - Nostr profile containing lightning addresses
   * @returns Validation score (0.0 or 1.0)
   */
  private async validateLightning(profile: NostrProfile): Promise<number> {
    if (!profile) {
      return 0.0;
    }

    // Check for lud16 (Lightning Address format) first
    if (profile.lud16) {
      return this.isValidLightningAddressFormat(profile.lud16) ? 1.0 : 0.0;
    }

    // Check for lud06 (LNURL format)
    if ((profile as any).lud06) {
      return this.isValidLnurlFormat((profile as any).lud06) ? 1.0 : 0.0;
    }

    // No Lightning address found
    return 0.0;
  }

  /**
   * Validate presence of kind 10002 events (relay list metadata)
   * @param pubkey - Public key to check
   * @returns Validation score (0.0 or 1.0)
   */
  private async validateEvent(pubkey: string): Promise<number> {
    if (!pubkey || typeof pubkey !== "string") {
      return 0.0;
    }

    try {
      // Query for kind 10002 event with timeout
      const event = await this.withTimeout(
        this.pool.get(this.nostrRelays, {
          kinds: [10002],
          authors: [pubkey],
          limit: 1,
        }),
        this.timeoutMs,
      );

      return event ? 1.0 : 0.0;
    } catch (error) {
      // Any error results in failed validation
      return 0.0;
    }
  }

  /**
   * Validate reciprocity (mutual follow relationship)
   * @param sourcePubkey - Source public key
   * @param targetPubkey - Target public key
   * @returns Validation score (0.0 or 1.0)
   */
  private async validateReciprocity(
    sourcePubkey: string,
    targetPubkey: string,
  ): Promise<number> {
    if (
      !sourcePubkey ||
      !targetPubkey ||
      typeof sourcePubkey !== "string" ||
      typeof targetPubkey !== "string"
    ) {
      return 0.0;
    }

    try {
      // Ensure social graph is initialized
      if (!this.graphManager.isInitialized()) {
        return 0.0;
      }

      // Check if both pubkeys exist in the graph
      const sourceInGraph = this.graphManager.isInGraph(sourcePubkey);
      const targetInGraph = this.graphManager.isInGraph(targetPubkey);

      if (!sourceInGraph || !targetInGraph) {
        return 0.0;
      }

      // Check follow relationships
      const sourceFollowsTarget = this.graphManager.doesFollow(
        sourcePubkey,
        targetPubkey,
      );
      const targetFollowsSource = this.graphManager.doesFollow(
        targetPubkey,
        sourcePubkey,
      );

      // Reciprocity is only true if both follow each other
      return sourceFollowsTarget && targetFollowsSource ? 1.0 : 0.0;
    } catch (error) {
      // Any error results in failed validation
      return 0.0;
    }
  }

  /**
   * Fetch Nostr profile from relays
   * @param pubkey - Public key to fetch profile for
   * @returns Nostr profile object
   */
  private async fetchProfile(pubkey: string): Promise<NostrProfile> {
    try {
      const event = await this.withTimeout(
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
   * Validate NIP-05 format (basic email-like validation)
   * @param nip05 - NIP-05 identifier
   * @returns True if format is valid
   */
  private isValidNip05Format(nip05: string): boolean {
    if (!nip05 || typeof nip05 !== "string") {
      return false;
    }

    // Basic email-like format: local@domain
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(nip05)) {
      return false;
    }

    // Additional checks
    const parts = nip05.split("@");
    if (parts.length !== 2) {
      return false;
    }

    const local = parts[0];
    const domain = parts[1];

    // Local part validation
    if (!local || local.length === 0 || local.length > 64) {
      return false;
    }

    // Domain part validation
    if (!domain || domain.length === 0 || domain.length > 253) {
      return false;
    }

    // Check for valid domain characters
    const domainRegex = /^[a-zA-Z0-9.-]+$/;
    if (!domainRegex.test(domain)) {
      return false;
    }

    // Domain shouldn't start or end with dot or dash
    if (
      domain.startsWith(".") ||
      domain.endsWith(".") ||
      domain.startsWith("-") ||
      domain.endsWith("-")
    ) {
      return false;
    }

    return true;
  }

  /**
   * Validate Lightning Address format (user@domain.com)
   * @param address - Lightning address
   * @returns True if format is valid
   */
  private isValidLightningAddressFormat(address: string): boolean {
    if (!address || typeof address !== "string") {
      return false;
    }

    // Basic email-like format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(address)) {
      return false;
    }

    // Additional checks
    const parts = address.split("@");
    if (parts.length !== 2) {
      return false;
    }

    const [local, domain] = parts;

    // Local part validation (username)
    if (!local || local.length === 0 || local.length > 64) {
      return false;
    }

    // Domain part validation
    if (!domain || domain.length === 0 || domain.length > 253) {
      return false;
    }

    // Check for valid domain characters
    const domainRegex = /^[a-zA-Z0-9.-]+$/;
    if (!domainRegex.test(domain)) {
      return false;
    }

    // Domain shouldn't start or end with dot or dash
    if (
      domain.startsWith(".") ||
      domain.endsWith(".") ||
      domain.startsWith("-") ||
      domain.endsWith("-")
    ) {
      return false;
    }

    return true;
  }

  /**
   * Validate LNURL format
   * @param lnurl - LNURL string
   * @returns True if format is valid
   */
  private isValidLnurlFormat(lnurl: string): boolean {
    if (!lnurl || typeof lnurl !== "string") {
      return false;
    }

    // Check if it's a bech32 encoded LNURL
    if (lnurl.toLowerCase().startsWith("lnurl")) {
      // Basic bech32 format check
      const bech32Regex = /^lnurl1[ac-hj-np-z02-9]{8,}$/;
      return bech32Regex.test(lnurl.toLowerCase());
    }

    // Check if it's a URL format
    try {
      const url = new URL(lnurl);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  /**
   * Execute a promise with timeout
   * @param promise - Promise to execute
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise result
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    return Promise.race([promise, timeoutPromise]);
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
