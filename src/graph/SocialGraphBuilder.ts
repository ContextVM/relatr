import { RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import { DuckDBSocialGraphAnalyzer } from "nostr-social-duck";
import { DuckDBConnection } from "@duckdb/node-api";
import type { RelatrConfig } from "../types";
import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import type { NostrEvent } from "nostr-tools";
import { logger } from "../utils/Logger";

/**
 * Parameters for social graph creation
 */
export interface SocialGraphCreationParams {
  sourcePubkey: string;
  hops: number;
  connection: DuckDBConnection;
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
  socialGraph?: DuckDBSocialGraphAnalyzer;
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
    const { sourcePubkey, hops, connection } = params;

    logger.info("🚀 Starting social graph creation...");
    logger.info(`Pubkey ${sourcePubkey}, Hops ${hops}`);

    try {
      // Discover pubkeys in the social graph
      const { contactEvents } = await this.discoverPubkeys(sourcePubkey, hops);

      if (contactEvents.length === 0) {
        logger.warn(
          "⚠️ No contact list events found. The social graph will be empty.",
        );
        return {
          success: true,
          message: "No contact list events found, graph is empty.",
          eventsFetched: 0,
          graphSize: { users: 0, follows: 0 },
        };
      }

      logger.info(
        `📊 Found ${contactEvents.length} contact list events. Building graph...`,
      );

      const socialGraph: DuckDBSocialGraphAnalyzer =
        await DuckDBSocialGraphAnalyzer.connect(
          connection,
          undefined,
          sourcePubkey,
        );

      // Ingest all contact events
      await socialGraph.ingestEvents(contactEvents);

      const graphStats = await socialGraph.getStats();
      logger.info(
        `✅ Graph stats: ${graphStats.totalFollows.toLocaleString()} total follows.`,
      );

      const message = `DuckDB social graph updated in shared database.`;
      logger.info(`✨ ${message}`);

      return {
        success: true,
        message,
        eventsFetched: contactEvents.length,
        graphSize: {
          users: graphStats.uniqueFollowers,
          follows: graphStats.totalFollows,
        },
        socialGraph: connection ? socialGraph : undefined,
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
    const pubkeysToCrawl: Set<string> = new Set([sourcePubkey]);
    const allContactEvents: NostrEvent[] = [];

    for (let hop = 0; hop <= hops; hop++) {
      if (pubkeysToCrawl.size === 0) {
        logger.info(`🏁 Hop ${hop}: No new pubkeys to crawl.`);
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

      logger.info(
        `🔍 Hop ${hop}: Found ${hopContactEvents.length} contact events, discovered ${newDiscoveredThisHop.toLocaleString()} new pubkeys.`,
      );

      if (newDiscoveredThisHop === 0) {
        logger.info(
          `🛑 Hop ${hop}: no new pubkeys discovered, stopping early.`,
        );
        break;
      }
    }

    logger.info(
      `[SocialGraphBuilder] 🎯 Discovery complete: ${allContactEvents.length.toLocaleString()} total contact events from ${crawledPubkeys.size.toLocaleString()} pubkeys across ${hops} hops.`,
    );

    return {
      pubkeys: Array.from(crawledPubkeys),
      contactEvents: allContactEvents,
    };
  }
}
