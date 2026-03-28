import { RelayPool } from "applesauce-relay";
import { DuckDBSocialGraphAnalyzer } from "nostr-social-duck";
import { DuckDBConnection } from "@duckdb/node-api";
import { fetchEventsForPubkeys } from "@/utils/utils.nostr";
import { logger } from "../utils/Logger";
import { dbWriteQueue } from "@/database/DbWriteQueue";

const GRAPH_FETCH_MAX_ATTEMPTS = 3;
const GRAPH_FETCH_RETRY_DELAY_MS = 1000;

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
  eventsFetched: number;
}

/**
 * Builder class responsible for creating and saving the social graph
 * Separates the concerns of social graph creation from the main service
 */
export class SocialGraphBuilder {
  private pool: RelayPool;

  constructor(pool: RelayPool) {
    this.pool = pool;
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

    let socialGraph: DuckDBSocialGraphAnalyzer | null = null;
    let totalEventsFetched = 0;

    try {
      // Initialize social graph analyzer early for streaming ingestion
      socialGraph = await DuckDBSocialGraphAnalyzer.connect(
        connection,
        undefined,
        sourcePubkey,
      );

      // Discover pubkeys in the social graph with streaming ingestion
      const { eventsFetched } = await this.discoverPubkeys(
        sourcePubkey,
        hops,
        socialGraph,
      );
      totalEventsFetched = eventsFetched;

      if (totalEventsFetched === 0) {
        logger.warn(
          "⚠️ No contact list events found. The social graph will be empty.",
        );
        await socialGraph.close();
        return {
          success: true,
          message: "No contact list events found, graph is empty.",
          eventsFetched: 0,
          graphSize: { users: 0, follows: 0 },
        };
      }

      logger.info(
        `📊 Processed ${totalEventsFetched} contact list events. Building graph...`,
      );

      const graphStats = await socialGraph.getStats();
      logger.info(
        `✅ Graph stats: ${graphStats.totalFollows.toLocaleString()} total follows.`,
      );

      const message = `DuckDB social graph updated in shared database.`;
      logger.info(`✨ ${message}`);

      return {
        success: true,
        message,
        eventsFetched: totalEventsFetched,
        graphSize: {
          users: graphStats.uniqueFollowers,
          follows: graphStats.totalFollows,
        },
        socialGraph: connection ? socialGraph : undefined,
      };
    } catch (error) {
      // Clean up social graph on error
      if (socialGraph) {
        await socialGraph.close();
      }
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
    socialGraph?: DuckDBSocialGraphAnalyzer,
  ): Promise<DiscoveryResult> {
    const crawledPubkeys: Set<string> = new Set();
    const pubkeysToCrawl: Set<string> = new Set([sourcePubkey]);
    let totalEventsFetched = 0;

    const maxHopIndex = this.resolveMaxHopIndex(hops);

    for (let hop = 0; hop <= maxHopIndex; hop++) {
      if (pubkeysToCrawl.size === 0) {
        logger.info(`🏁 Hop ${hop}: No new pubkeys to crawl.`);
        break;
      }

      const pubkeysForThisHop = Array.from(pubkeysToCrawl);
      pubkeysForThisHop.forEach((pk) => crawledPubkeys.add(pk));
      pubkeysToCrawl.clear();

      let newDiscoveredThisHop = 0;
      let hopEventsFetched = 0;

      for (let attempt = 1; attempt <= GRAPH_FETCH_MAX_ATTEMPTS; attempt++) {
        // Fetch contact lists for this hop with streaming ingestion to avoid memory accumulation
        // Events are processed immediately via onBatch callback and ingested into DuckDB,
        // preventing O(n) memory scaling with network size.
        await fetchEventsForPubkeys(
          pubkeysForThisHop,
          3,
          undefined,
          this.pool,
          {
            onBatch: async (events) => {
              hopEventsFetched += events.length;

              // Ingest events immediately if socialGraph is provided - this is key for memory efficiency
              if (socialGraph && events.length > 0) {
                // Serialize ingestion to avoid transaction conflicts on the shared connection
                await dbWriteQueue.runExclusive(async () => {
                  await socialGraph.ingestEvents(events);
                });
              }

              // Extract new pubkeys for next hop on the fly to avoid storing all events
              for (const event of events) {
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
            },
          },
        );

        if (hopEventsFetched > 0 || attempt === GRAPH_FETCH_MAX_ATTEMPTS) {
          break;
        }

        logger.warn(
          `⚠️ Hop ${hop}: no contact events returned for ${pubkeysForThisHop.length.toLocaleString()} pubkeys on attempt ${attempt}/${GRAPH_FETCH_MAX_ATTEMPTS}. Retrying...`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, GRAPH_FETCH_RETRY_DELAY_MS * attempt),
        );
      }

      totalEventsFetched += hopEventsFetched;

      logger.info(
        `🔍 Hop ${hop}: Found ${hopEventsFetched} contact events, discovered ${newDiscoveredThisHop.toLocaleString()} new pubkeys.`,
      );

      if (newDiscoveredThisHop === 0) {
        logger.info(
          `🛑 Hop ${hop}: no new pubkeys discovered, stopping early.`,
        );
        break;
      }
    }

    logger.info(
      `[SocialGraphBuilder] 🎯 Discovery complete: ${totalEventsFetched.toLocaleString()} total contact events from ${crawledPubkeys.size.toLocaleString()} pubkeys across ${hops} hops.`,
    );

    return {
      pubkeys: Array.from(crawledPubkeys),
      eventsFetched: totalEventsFetched,
    };
  }

  private resolveMaxHopIndex(hops: number): number {
    return Math.max(0, hops - 1);
  }
}
