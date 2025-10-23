import { RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import { SocialGraph as NostrSocialGraph } from "nostr-social-graph";
import type { RelatrConfig } from "../types";
import { SimplePool } from "nostr-tools/pool";
import { fetchEventsForPubkeys } from "@/utils.nostr";
import type { NostrEvent } from "nostr-tools";

/**
 * Parameters for social graph creation
 */
export interface SocialGraphCreationParams {
  sourcePubkey: string;
  hops: number;
}

/**
 * Result of social graph creation
 */
export interface SocialGraphCreationResult {
  success: boolean;
  message: string;
  eventsFetched: number;
  graphSize: {
    users: number;
    follows: number;
  };
}

interface DiscoveryResult {
  pubkeys: string[];
  contactEvents: NostrEvent[];
}

/**
 * Builder class responsible for creating and saving the social graph
 * Separates the concerns of social graph creation from the main service
 */
export class SocialGraphBuilder {
  private config: RelatrConfig;
  private pool: RelayPool;
  private eventStore?: EventStore;

  constructor(config: RelatrConfig, pool: RelayPool, eventStore?: EventStore) {
    this.config = config;
    this.pool = pool;
    this.eventStore = eventStore;
  }

  /**
   * Creates a social graph by discovering contacts and building the graph
   * @param params Parameters for graph creation including source pubkey and hops
   * @returns Result of the graph creation process
   */
  public async createGraph(
    params: SocialGraphCreationParams,
  ): Promise<SocialGraphCreationResult> {
    const { sourcePubkey, hops } = params;

    console.log("[SocialGraphBuilder] 🚀 Starting social graph creation...");

    try {
      // Discover pubkeys in the social graph
      const { contactEvents } = await this.discoverPubkeys(sourcePubkey, hops);

      if (contactEvents.length === 0) {
        console.warn(
          "[SocialGraphBuilder] ⚠️ No contact list events found. The social graph will be empty.",
        );
        return {
          success: true,
          message: "No contact list events found, graph is empty.",
          eventsFetched: 0,
          graphSize: { users: 0, follows: 0 },
        };
      }

      console.log(
        `[SocialGraphBuilder] 📊 Found ${contactEvents.length} contact list events. Building graph...`,
      );

      // Create and populate the social graph
      const socialGraph = new NostrSocialGraph(sourcePubkey);
      for (const event of contactEvents) {
        socialGraph.handleEvent(event);
      }

      console.log("[SocialGraphBuilder] 🔄 Recalculating follow distances...");
      await socialGraph.recalculateFollowDistances();

      const graphSize = socialGraph.size();
      console.log(
        `[SocialGraphBuilder] ✅ Graph stats: ${graphSize.users.toLocaleString()} users, ${graphSize.follows.toLocaleString()} follows.`,
      );

      // Serialize and save the graph
      console.log(
        "[SocialGraphBuilder] 💾 Serializing graph to binary file...",
      );
      const binaryData = await socialGraph.toBinary();
      await Bun.write(this.config.graphBinaryPath, binaryData);

      const message = `Binary social graph saved to ${this.config.graphBinaryPath} (${binaryData.length} bytes).`;
      console.log(`[SocialGraphBuilder] ✨ ${message}`);

      return {
        success: true,
        message,
        eventsFetched: contactEvents.length,
        graphSize,
      };
    } catch (error) {
      throw new Error(
        `Social graph creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Discover pubkeys in the social graph by crawling through contact lists
   * @param sourcePubkey The starting pubkey for discovery
   * @param hops Number of hops to crawl
   * @param relays Relays to query (optional)
   * @returns Array of discovered pubkeys
   */
  private async discoverPubkeys(
    sourcePubkey: string,
    hops: number,
  ): Promise<DiscoveryResult> {
    const crawledPubkeys: Set<string> = new Set();
    let pubkeysToCrawl: Set<string> = new Set([sourcePubkey]);
    const allContactEvents: NostrEvent[] = [];

    for (let hop = 0; hop <= hops; hop++) {
      if (pubkeysToCrawl.size === 0) {
        console.log(
          `[SocialGraphBuilder] 🏁 Hop ${hop}: No new pubkeys to crawl.`,
        );
        break;
      }

      const pubkeysForThisHop = Array.from(pubkeysToCrawl);
      pubkeysForThisHop.forEach((pk) => crawledPubkeys.add(pk));
      pubkeysToCrawl.clear();

      let newDiscoveredThisHop = 0;

      // Fetch contact lists for this hop
      const hopContactEvents = await fetchEventsForPubkeys(
        pubkeysForThisHop,
        3,
        undefined,
        this.pool,
        this.eventStore,
      );

      // Accumulate events from all hops
      allContactEvents.push(...hopContactEvents);

      for (const event of hopContactEvents) {
        for (const tag of event.tags) {
          if (tag[0] !== "p") continue;
          const candidate = tag[1];
          if (!candidate) continue;
          if (crawledPubkeys.has(candidate)) continue;
          if (pubkeysToCrawl.has(candidate)) continue;
          pubkeysToCrawl.add(candidate);
          newDiscoveredThisHop++;
        }
      }

      console.log(
        `[SocialGraphBuilder] 🔍 Hop ${hop}: Found ${hopContactEvents.length} contact events, discovered ${newDiscoveredThisHop.toLocaleString()} new pubkeys.`,
      );

      if (newDiscoveredThisHop === 0) {
        console.log(
          `[SocialGraphBuilder] 🛑 Hop ${hop}: no new pubkeys discovered, stopping early.`,
        );
        break;
      }
    }

    console.log(
      `[SocialGraphBuilder] 🎯 Discovery complete: ${allContactEvents.length.toLocaleString()} total contact events from ${crawledPubkeys.size.toLocaleString()} pubkeys across ${hops} hops.`,
    );

    return {
      pubkeys: Array.from(crawledPubkeys),
      contactEvents: allContactEvents,
    };
  }
}
