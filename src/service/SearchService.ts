import { RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import type {
  NostrProfile,
  RelatrConfig,
  SearchProfilesParams,
  SearchProfilesResult,
} from "../types";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { SocialGraph } from "../graph/SocialGraph";
import type { MetricsValidator } from "../validators/MetricsValidator";
import type { TrustCalculator } from "../trust/TrustCalculator";
import type { ISearchService } from "./ServiceInterfaces";
import { ValidationError } from "../types";
import { logger } from "../utils/Logger";
import { SEARCH_RELAYS } from "@/constants/nostr";
import { nowMs } from "@/utils/utils";

export class SearchService implements ISearchService {
  private static readonly FIELD_WEIGHTS = {
    name: 0.5,
    display_name: 0.35,
    nip05: 0.1,
  };

  constructor(
    private config: RelatrConfig,
    private metadataRepository: MetadataRepository,
    private socialGraph: SocialGraph,
    private metricsValidator: MetricsValidator,
    private trustCalculator: TrustCalculator,
    private pool: RelayPool,
  ) {}

  async searchProfiles(
    params: SearchProfilesParams,
  ): Promise<SearchProfilesResult> {
    const { query, limit = 5, sourcePubkey, extendToNostr } = params;

    if (!query || typeof query !== "string") {
      throw new ValidationError("Invalid search query", "query");
    }

    const effectiveSourcePubkey =
      sourcePubkey ||
      this.socialGraph.getCurrentRoot() ||
      this.config.defaultSourcePubkey;
    const startTime = nowMs();

    // Search local database - returns top N results ranked by text relevance + root distance
    const localResults = await this.metadataRepository.search(
      query,
      limit,
      this.config.decayFactor,
    );

    logger.debug(
      `🔍 Found ${localResults.length} distance-ranked profiles from database`,
    );

    // Prepare profiles for trust scoring
    const profilesForScoring = localResults.map((r) => ({
      pubkey: r.pubkey,
      relevanceMultiplier: r.score,
      isExactMatch: r.isExactMatch,
    }));

    // Extend to Nostr if needed
    const nostrProfiles = await this.extendSearchWithNostr(
      query,
      limit,
      profilesForScoring,
      extendToNostr,
    );

    // Process and return final results
    return this.processSearchResults(
      [...profilesForScoring, ...nostrProfiles],
      nostrProfiles,
      effectiveSourcePubkey,
      limit,
      startTime,
    );
  }

  /**
   * Extend search to Nostr relays for additional results
   */
  private async extendSearchWithNostr(
    query: string,
    limit: number,
    profilesForScoring: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    extendToNostr?: boolean,
  ): Promise<
    { pubkey: string; relevanceMultiplier: number; isExactMatch: boolean }[]
  > {
    const nostrProfiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[] = [];
    const shouldExtendToNostr =
      extendToNostr || profilesForScoring.length === 0;

    if (!shouldExtendToNostr || !this.pool) {
      return nostrProfiles;
    }

    const remaining = Math.max(0, limit - profilesForScoring.length);
    if (remaining <= 0) {
      return nostrProfiles;
    }

    logger.debug(
      `🔍 Extending search to Nostr relays for up to ${remaining} results`,
    );

    const searchFilter = { kinds: [0], search: query, limit: remaining };

    try {
      const nostrEvents = await new Promise<NostrEvent[]>((resolve, reject) => {
        const events: NostrEvent[] = [];
        const subscription = this.pool
          .request(SEARCH_RELAYS, searchFilter)
          .subscribe({
            next: (event) => events.push(event),
            error: (error) => reject(error),
            complete: () => resolve(events),
          });

        setTimeout(() => {
          subscription.unsubscribe();
          resolve(events);
        }, 5000);
      });

      for (const event of nostrEvents) {
        const existingPubkey = profilesForScoring.find(
          (p) => p.pubkey === event.pubkey,
        );
        if (
          !existingPubkey &&
          !nostrProfiles.find((p) => p.pubkey === event.pubkey)
        ) {
          const profile = JSON.parse(event.content);
          const { multiplier, isExactMatch } =
            this.calculateRelevanceMultiplier(profile, query);
          nostrProfiles.push({
            pubkey: event.pubkey,
            relevanceMultiplier: multiplier,
            isExactMatch,
          });
          this.metadataRepository
            .save({ pubkey: event.pubkey, ...profile })
            .catch((err) => {
              logger.warn(`Failed to cache profile for ${event.pubkey}:`, err);
            });
        }
      }
    } catch {
      // Remote search failed, continue with local results only
      logger.debug(
        "Nostr relay search failed, continuing with local results only",
      );
    }

    return nostrProfiles;
  }

  /**
   * Process search results by calculating trust scores and formatting output
   */
  private async processSearchResults(
    finalProfiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    nostrProfiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    effectiveSourcePubkey: string,
    limit: number,
    startTime: number,
  ): Promise<SearchProfilesResult> {
    const profilesWithScores = await this.calculateProfileScores(
      finalProfiles,
      effectiveSourcePubkey,
    );

    // Sort by trust score and return top results
    profilesWithScores.sort((a, b) => b.trustScore - a.trustScore);

    const results = profilesWithScores.slice(0, limit).map((item, index) => ({
      pubkey: item.pubkey,
      trustScore: item.trustScore,
      rank: index + 1,
      exactMatch: item.exactMatch,
    }));

    const endTime = nowMs();
    logger.info(`Search completed in ${endTime - startTime}ms`);

    return {
      results,
      totalFound: results.length,
      searchTimeMs: endTime - startTime,
    };
  }

  async calculateProfileScores(
    profiles: {
      pubkey: string;
      relevanceMultiplier: number;
      isExactMatch: boolean;
    }[],
    effectiveSourcePubkey: string,
  ): Promise<{ pubkey: string; trustScore: number; exactMatch: boolean }[]> {
    if (profiles.length === 0) {
      return [];
    }

    try {
      // Extract pubkeys for batch operations
      const profilePubkeys = profiles.map((p) => p.pubkey);

      // Pre-fetch all distances and metrics in parallel
      const [distances, metricsMap] = await Promise.all([
        this.socialGraph.getDistancesBatch(profilePubkeys),
        this.metricsValidator.validateAllBatch(
          profilePubkeys,
          effectiveSourcePubkey,
        ),
      ]);

      // Calculate trust scores with pre-fetched data
      const results = profiles.map(
        ({ pubkey, relevanceMultiplier, isExactMatch }) => {
          try {
            const distance = distances.get(pubkey) || 1000;
            const metrics = metricsMap.get(pubkey);

            if (!metrics) {
              return {
                pubkey,
                rawScore: 0,
                exactMatch: isExactMatch,
              };
            }

            const trustScore = this.trustCalculator.calculate(
              effectiveSourcePubkey,
              pubkey,
              metrics,
              distance,
            );

            let finalRelevanceMultiplier = relevanceMultiplier;
            if (isExactMatch) {
              finalRelevanceMultiplier *= 1.15;
            }

            const rawCombinedScore =
              trustScore.score * finalRelevanceMultiplier;

            return {
              pubkey,
              rawScore: rawCombinedScore,
              exactMatch: isExactMatch,
            };
          } catch (error) {
            logger.warn(
              `Failed to calculate trust score for ${pubkey}:`,
              error instanceof Error ? error.message : String(error),
            );
            return {
              pubkey,
              rawScore: 0,
              exactMatch: isExactMatch,
            };
          }
        },
      );

      // Single normalization point - normalize all scores to 0-1 range
      const maxRawScore = Math.max(...results.map((r) => r.rawScore), 1.0);

      return results.map((result) => ({
        pubkey: result.pubkey,
        trustScore: Number((result.rawScore / maxRawScore).toFixed(2)),
        exactMatch: result.exactMatch,
      }));
    } catch (error) {
      logger.warn(
        `Batch scoring failed, falling back to individual scoring:`,
        error instanceof Error ? error.message : String(error),
      );
      return this.calculateProfileScores(profiles, effectiveSourcePubkey);
    }
  }

  calculateRelevanceMultiplier(
    profile: NostrProfile,
    query: string,
  ): { multiplier: number; isExactMatch: boolean } {
    const queryLower = query.toLowerCase();
    let relevanceScore = 0;
    let isExactMatch = false;

    for (const [field, weight] of Object.entries(SearchService.FIELD_WEIGHTS)) {
      const fieldValue = profile[field as keyof NostrProfile];
      if (typeof fieldValue === "string" && fieldValue.trim()) {
        const valueLower = fieldValue.toLowerCase();

        // Only count as exact match if the ENTIRE field equals the query
        if (valueLower === queryLower) {
          relevanceScore += weight;
          if (field === "name" || field === "display_name") {
            isExactMatch = true;
          }
        } else if (valueLower.startsWith(queryLower)) {
          relevanceScore += weight * 0.85;
        } else if (valueLower.includes(queryLower)) {
          relevanceScore += weight * 0.55;
        } else {
          const wordBoundaryRegex = new RegExp(`\\b${queryLower}\\b`, "i");
          if (wordBoundaryRegex.test(fieldValue)) {
            relevanceScore += weight * 0.35;
          }
        }
      }
    }

    const normalizedRelevanceScore = Math.min(1, relevanceScore);
    const maxMultiplier = 1.4;
    const relevanceMultiplier =
      1.0 + normalizedRelevanceScore * (maxMultiplier - 1.0);

    return {
      multiplier: Number(relevanceMultiplier.toFixed(3)), // Avoid floating point precision issues
      isExactMatch,
    };
  }
}
