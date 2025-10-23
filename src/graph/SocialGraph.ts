import { SocialGraph as NostrSocialGraph } from "nostr-social-graph";
import { SocialGraphError } from "../types";

/**
 * Social graph operations wrapper for Relatr v2
 * Provides simplified interface to nostr-social-graph library
 */
export class SocialGraph {
  private graph: NostrSocialGraph | null = null;
  private binaryPath: string;
  private rootPubkey: string;
  private initialized: boolean = false;

  /**
   * Create a new SocialGraph instance
   * @param binaryPath - Path to the social graph binary file
   */
  constructor(binaryPath: string) {
    if (!binaryPath) {
      throw new SocialGraphError("Binary path is required", "CONSTRUCTOR");
    }
    this.binaryPath = binaryPath;
    this.rootPubkey = ""; // Will be set during initialization
  }

  /**
   * Initialize the social graph by loading the binary file
   * @param rootPubkey - Root public key to use for distance calculations
   * @throws SocialGraphError if initialization fails
   */
  async initialize(rootPubkey?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const root =
        rootPubkey ||
        "0000000000000000000000000000000000000000000000000000000000000000";
      this.rootPubkey = root;

      const file = Bun.file(this.binaryPath);
      const exists = await file.exists();

      if (exists) {
        const binary = new Uint8Array(await file.arrayBuffer());
        this.graph = await NostrSocialGraph.fromBinary(root, binary);
      } else {
        console.warn(
          `[SocialGraph] Binary file not found at ${this.binaryPath}. Creating a new empty graph.`,
        );
        this.graph = new NostrSocialGraph(root);
      }

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
  getDistance(targetPubkey: string): number {
    this.ensureInitialized();

    if (!targetPubkey || typeof targetPubkey !== "string") {
      throw new SocialGraphError(
        "Target pubkey must be a non-empty string",
        "GET_DISTANCE",
      );
    }

    try {
      return this.graph!.getFollowDistance(targetPubkey);
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get distance for ${targetPubkey}: ${error instanceof Error ? error.message : String(error)}`,
        "GET_DISTANCE",
      );
    }
  }

  /**
   * Switch the root pubkey and recalculate distances
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
      this.rootPubkey = newRoot;
      await this.graph!.setRoot(newRoot);
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
  doesFollow(source: string, target: string): boolean {
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
      return this.graph!.isFollowing(source, target);
    } catch (error) {
      throw new SocialGraphError(
        `Failed to check if ${source} follows ${target}: ${error instanceof Error ? error.message : String(error)}`,
        "DOES_FOLLOW",
      );
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
  getStats(): { users: number; follows: number } {
    this.ensureInitialized();

    try {
      return this.graph!.size();
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
  isInGraph(pubkey: string): boolean {
    this.ensureInitialized();

    if (!pubkey || typeof pubkey !== "string") {
      throw new SocialGraphError(
        "Pubkey must be a non-empty string",
        "IS_IN_GRAPH",
      );
    }

    try {
      // Check if distance is less than 1000 (reachable)
      const distance = this.graph!.getFollowDistance(pubkey);
      if (distance < 1000) {
        return true;
      }

      // Additional check: try to get muted users to verify existence
      try {
        this.graph!.getMutedByUser(pubkey);
        return true;
      } catch {
        return false;
      }
    } catch (error) {
      throw new SocialGraphError(
        `Failed to check if ${pubkey} is in graph: ${error instanceof Error ? error.message : String(error)}`,
        "IS_IN_GRAPH",
      );
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
      return Array.from(this.graph!.getMutedByUser(pubkey));
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
      return Array.from(this.graph!.getUserMutedBy(pubkey));
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
      const currentRoot = this.rootPubkey;

      // If source is already root, just get distance
      if (currentRoot === sourcePubkey) {
        return this.graph!.getFollowDistance(targetPubkey);
      }

      // Otherwise, temporarily switch root
      await this.graph!.setRoot(sourcePubkey);
      const distance = this.graph!.getFollowDistance(targetPubkey);

      // Switch back to original root
      await this.graph!.setRoot(currentRoot);

      return distance;
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
  public getUsersUpToDistance(distance: number): string[] {
    this.ensureInitialized();

    try {
      return Array.from(this.graph!.userIterator(distance));
    } catch (error) {
      throw new SocialGraphError(
        `Failed to get users by distance: ${error instanceof Error ? error.message : String(error)}`,
        "GET_USERS_BY_DISTANCE",
      );
    }
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
  cleanup(): void {
    this.graph = null;
    this.initialized = false;
  }
}
