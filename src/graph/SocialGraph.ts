import { DuckDBSocialGraphAnalyzer, executeWithRetry } from "nostr-social-duck";
import { DuckDBConnection } from "@duckdb/node-api";
import { SocialGraphError } from "../types";
import type { NostrEvent } from "nostr-tools";
import { logger } from "../utils/Logger";
import { dbWriteQueue } from "@/database/DbWriteQueue";

/**
 * Social graph operations wrapper for Relatr v2
 * Provides simplified interface to nostr-social-duck library
 */
export class SocialGraph {
  private graph: DuckDBSocialGraphAnalyzer | null = null;
  private connection: DuckDBConnection | null = null;
  private rootPubkey: string;
  private initialized: boolean = false;

  /**
   * Create a new SocialGraph instance
   * @param connection - DuckDBConnection instance to use
   * @param existingGraph - Optional existing DuckDBSocialGraphAnalyzer instance to reuse
   */
  constructor(
    connection: DuckDBConnection,
    existingGraph?: DuckDBSocialGraphAnalyzer,
  ) {
    if (!connection) {
      throw new SocialGraphError("DuckDBConnection is required", "CONSTRUCTOR");
    }
    this.connection = connection;
    this.rootPubkey = ""; // Will be set during initialization

    if (existingGraph) {
      this.graph = existingGraph;
    }
  }

  /**
   * Initialize the social graph by creating or loading a DuckDB analyzer
   * @param rootPubkey - Root public key to use for distance calculations
   * @throws SocialGraphError if initialization fails
   */
  async initialize(rootPubkey: string): Promise<void> {
    if (this.initialized) {
      logger.warn("⚠️ Social graph already initialized");
      return;
    }

    if (!this.connection) {
      throw new SocialGraphError("DuckDBConnection is required", "INITIALIZE");
    }

    try {
      this.rootPubkey = rootPubkey;

      // If we already have a graph instance (from constructor), just set the root pubkey
      if (this.graph) {
        logger.info(
          `🔍 Reusing existing graph, setting root pubkey: ${rootPubkey}`,
        );
        await this.graph.setRootPubkey(rootPubkey);
      } else {
        // Otherwise, create a new graph instance
        logger.info(`🚀 Creating new graph analyzer with root: ${rootPubkey}`);
        this.graph = await DuckDBSocialGraphAnalyzer.connect(
          this.connection,
          undefined,
          this.rootPubkey,
        );
        logger.info(`✅ Graph analyzer created successfully`);
      }

      this.initialized = true;
      logger.info(`✅ Social graph initialized successfully`);
    } catch (error) {
      throw new SocialGraphError(
        `Failed to initialize social graph: ${error instanceof Error ? error.message : String(error)}`,
        "INITIALIZE",
      );
    }
  }

  /**
   * Get the follow distance from current root to target pubkey
   * @param targetPubkey - Target public key to get distance to
   * @returns Number of hops (1000 if unreachable)
   * @throws SocialGraphError if graph is not initialized
   */
  async getDistance(targetPubkey: string): Promise<number> {
    this.ensureInitialized();

    if (!targetPubkey || typeof targetPubkey !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "GET_DISTANCE",
      );
    }

    try {
      const distance = await this.graph!.getShortestDistance(
        this.rootPubkey,
        targetPubkey,
      );

      return distance !== null ? distance : 1000;
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get distance for ${targetPubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_DISTANCE",
      );
    }
  }

  /**
   * Get distances for multiple pubkeys in a single batch operation
   * Leverages precomputed distances from nostr-social-duck's nsd_root_distances table
   * @param pubkeys - Array of target public keys
   * @returns Map of pubkey to distance (1000 if unreachable)
   * @throws SocialGraphError if graph is not initialized
   */
  async getDistancesBatch(
    pubkeys: string[],
  ): Promise<Map<string, number | null>> {
    this.ensureInitialized();

    if (!pubkeys || !Array.isArray(pubkeys)) {
      throw new SocialGraphError(
        "Pubkeys must be a non-empty array",
        "GET_DISTANCES_BATCH",
      );
    }

    if (pubkeys.length === 0) {
      return new Map();
    }

    try {
      return await this.graph!.getShortestDistancesBatch(
        this.rootPubkey,
        pubkeys,
      );
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get distances batch: ${error instanceof Error ? error.message : String(error)}`,
        "GET_DISTANCES_BATCH",
      );
    }
  }

  /**
   * Switch the root pubkey
   * @param newRoot - New root public key
   * @throws SocialGraphError if operation fails
   */
  async switchRoot(newRoot: string): Promise<void> {
    this.ensureInitialized();

    if (!newRoot || typeof newRoot !== "string") {
      throw new SocialGraphError(
        "New root must be a non-empty string",
        "SWITCH_ROOT",
      );
    }

    try {
      await this.graph!.setRootPubkey(newRoot);
      this.rootPubkey = newRoot;
    } catch (error) {
      throw new SocialGraphError(
        `Failed to switch root to ${newRoot}: ${error instanceof Error ? error.message : String(error)}`,
        "SWITCH_ROOT",
      );
    }
  }

  /**
   * Check if source pubkey follows target pubkey
   * @param source - Source public key
   * @param target - Target public key
   * @returns True if source follows target
   * @throws SocialGraphError if operation fails
   */
  async doesFollow(source: string, target: string): Promise<boolean> {
    this.ensureInitialized();

    if (!source || typeof source !== "string") {
      throw new SocialGraphError(
        "Source pubkey must be a non-empty string",
        "DOES_FOLLOW",
      );
    }

    if (!target || typeof target !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "DOES_FOLLOW",
      );
    }

    try {
      return await executeWithRetry(async () => {
        return await this.graph!.isDirectFollow(source, target);
      });
    } catch (error) {
      logger.warn(
        `Failed to check if ${source} follows ${target} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async areMutualFollows(source: string, target: string): Promise<boolean> {
    this.ensureInitialized();

    if (!source || typeof source !== "string") {
      throw new SocialGraphError(
        "Source pubkey must be a non-empty string",
        "DOES_FOLLOW",
      );
    }

    if (!target || typeof target !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "DOES_FOLLOW",
      );
    }

    try {
      return await executeWithRetry(async () => {
        return await this.graph!.areMutualFollows(source, target);
      });
    } catch (error) {
      logger.warn(
        `Failed to check mutual follows between ${source} and ${target} after retries:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Check if the social graph is initialized
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.graph !== null;
  }

  /**
   * Get the current root pubkey
   * @returns Current root public key
   * @throws SocialGraphError if graph is not initialized
   */
  getCurrentRoot(): string {
    this.ensureInitialized();
    return this.rootPubkey;
  }

  /**
   * Get graph statistics
   * @returns Object with graph statistics
   * @throws SocialGraphError if operation fails
   */
  async getStats(): Promise<{
    users: number;
    follows: number;
    sizeByDistance: {
      [distance: number]: number;
    };
  }> {
    this.ensureInitialized();

    try {
      // Get basic stats from DuckDB
      const stats = {
        users: 0,
        follows: 0,
        sizeByDistance: {} as { [distance: number]: number },
      };

      this.ensureInitialized();
      const statsResult = await this.graph?.getStats();
      const pubkeyDistribution = await this.graph?.getDistanceDistribution();
      stats.users = statsResult?.totalFollows || 0;
      stats.follows = statsResult?.totalFollows || 0;
      stats.sizeByDistance = Object.fromEntries(
        Object.entries(pubkeyDistribution!).map(([key, value]) => [
          parseInt(key),
          value,
        ]),
      );

      return stats;
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get graph stats: ${error instanceof Error ? error.message : String(error)}`,
        "GET_STATS",
      );
    }
  }

  /**
   * Check if a pubkey exists in the graph
   * @param pubkey - Public key to check
   * @returns True if pubkey exists in graph
   * @throws SocialGraphError if operation fails
   */
  async isInGraph(pubkey: string): Promise<boolean> {
    this.ensureInitialized();

    if (!pubkey || typeof pubkey !== "string") {
      throw new SocialGraphError(
        "Pubkey must be a non-empty string",
        "IS_IN_GRAPH",
      );
    }

    try {
      return await this.graph!.pubkeyExists(pubkey);
    } catch (error) {
      // Log the error but don't crash the service
      logger.warn(
        `Failed to check if ${pubkey} is in graph: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Get distance between two pubkeys by temporarily switching root
   * @param sourcePubkey - Source public key
   * @param targetPubkey - Target public key
   * @returns Distance in hops (1000 if unreachable)
   * @throws SocialGraphError if operation fails
   */
  async getDistanceBetween(
    sourcePubkey: string,
    targetPubkey: string,
  ): Promise<number> {
    this.ensureInitialized();

    if (!sourcePubkey || typeof sourcePubkey !== "string") {
      throw new SocialGraphError(
        "Source pubkey must be a non-empty string",
        "GET_DISTANCE_BETWEEN",
      );
    }

    if (!targetPubkey || typeof targetPubkey !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "GET_DISTANCE_BETWEEN",
      );
    }

    try {
      const distance = await this.graph!.getShortestDistance(
        sourcePubkey,
        targetPubkey,
      );
      return distance !== null ? distance : 1000;
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get distance between ${sourcePubkey} and ${targetPubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_DISTANCE_BETWEEN",
      );
    }
  }

  /*
   * Get users by follow distance
   * @param distance - Distance to get users for
   * @returns Array of users
   */
  public async getUsersUpToDistance(distance: number): Promise<string[]> {
    this.ensureInitialized();

    try {
      return (
        (await this.graph!.getUsersWithinDistance(this.rootPubkey, distance)) ??
        []
      );
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get users by distance: ${error instanceof Error ? error.message : String(error)}`,
        "GET_USERS_BY_DISTANCE",
      );
    }
  }

  /*
   * Get users by follow distance
   * @param distance - Distance to get users for
   * @returns Array of users
   */
  public async getAllUsersInGraph(): Promise<string[]> {
    this.ensureInitialized();

    try {
      return await this.graph!.getAllUniquePubkeys();
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get users by distance: ${error instanceof Error ? error.message : String(error)}`,
        "GET_USERS_BY_DISTANCE",
      );
    }
  }

  /**
   * Process contact events to integrate pubkeys into graph
   * @param contactEvents - Contact list events for discovered pubkeys
   */
  async processContactEvents(contactEvents: NostrEvent[]): Promise<void> {
    this.ensureInitialized();
    // NOTE: ingestEvents mutates DuckDB tables. We use a shared DuckDB connection across the
    // process, so we serialize all writes to avoid transaction-context conflicts.
    await dbWriteQueue.runExclusive(async () => {
      await this.graph!.ingestEvents(contactEvents);
    });
  }

  /**
   * Ensure the graph is initialized before operations
   * @private
   * @throws SocialGraphError if graph is not initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.graph) {
      throw new SocialGraphError(
        "SocialGraph not initialized. Call initialize() first.",
        "NOT_INITIALIZED",
      );
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.graph) {
      await this.graph.close();
    }
    this.graph = null;
    this.initialized = false;
  }
}
