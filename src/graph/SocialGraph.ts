import { DuckDBSocialGraphAnalyzer } from "nostr-social-duck";
import { DuckDBConnection } from "@duckdb/node-api";
import { SocialGraphError } from "../types";
import type { NostrEvent } from "nostr-tools";

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
   */
  constructor(connection: DuckDBConnection) {
    if (!connection) {
      throw new SocialGraphError("DuckDBConnection is required", "CONSTRUCTOR");
    }
    this.connection = connection;
    this.rootPubkey = ""; // Will be set during initialization
  }

  /**
   * Initialize the social graph by creating or loading a DuckDB analyzer
   * @param rootPubkey - Root public key to use for distance calculations
   * @throws SocialGraphError if initialization fails
   */
  async initialize(rootPubkey: string): Promise<void> {
    if (this.initialized || !this.connection) {
      console.warn(
        "[SocialGraph] ⚠️ Social graph already initialized or connection not provided",
      );
      return;
    }

    try {
      this.rootPubkey = rootPubkey;

      // Use the shared connection passed in constructor
      this.graph = await DuckDBSocialGraphAnalyzer.connect(
        this.connection,
        undefined,
        this.rootPubkey,
      );

      this.initialized = true;
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
      return await this.graph!.isDirectFollow(source, target);
    } catch (error) {
      // Handle the case where the prepared statement fails
      console.warn(
        `Failed to check follow relationship between ${source} and ${target}:`,
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
    mutes: number;
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
        mutes: 0,
        sizeByDistance: {} as { [distance: number]: number },
      };

      this.ensureInitialized();
      const statsResult = await this.graph?.getStats();
      const pubkeyDistribution = await this.graph?.getDistanceDistribution();
      stats.users = statsResult?.totalFollows || 0;
      stats.follows = statsResult?.totalFollows || 0;
      stats.mutes = 0;
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
      console.warn(
        `Failed to check if ${pubkey} is in graph: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Get muted pubkeys for a user
   * @param pubkey - Public key of the user
   * @returns Array of muted pubkeys
   * @throws SocialGraphError if operation fails
   */
  getMutedByUser(pubkey: string): string[] {
    this.ensureInitialized();

    if (!pubkey || typeof pubkey !== "string") {
      throw new SocialGraphError(
        "Pubkey must be a non-empty string",
        "GET_MUTED_BY_USER",
      );
    }

    try {
      // nostr-social-duck doesn't support mute lists, return empty array
      return [];
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get muted users for ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_MUTED_BY_USER",
      );
    }
  }

  /**
   * Get users who muted a pubkey
   * @param pubkey - Public key to check
   * @returns Array of pubkeys that muted the target
   * @throws SocialGraphError if operation fails
   */
  getUserMutedBy(pubkey: string): string[] {
    this.ensureInitialized();

    if (!pubkey || typeof pubkey !== "string") {
      throw new SocialGraphError(
        "Pubkey must be a non-empty string",
        "GET_USER_MUTED_BY",
      );
    }

    try {
      // nostr-social-duck doesn't support mute lists, return empty array
      return [];
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get users who muted ${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_USER_MUTED_BY",
      );
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
    await this.graph!.ingestEvents(contactEvents);
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
