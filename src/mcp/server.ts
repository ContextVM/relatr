import { validateAndDecodePubkey } from "@/utils/utils.nostr.js";
import {
  ApplesauceRelayPool,
  NostrServerTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { RelatrFactory } from "../service/RelatrFactory.js";
import { RelatrService } from "../service/RelatrService.js";
import { TAService } from "../service/TAService.js";
import type { SearchProfileResult } from "../types.js";
import { logger } from "../utils/Logger.js";
import { relaySet } from "applesauce-core/helpers";

/**
 * Start the MCP server for Relatr
 *
 * This function initializes the RelatrService, creates and configures the MCP server,
 * registers the required tools, and handles graceful shutdown.
 */
export async function startMCPServer(): Promise<void> {
  let relatrService: RelatrService | null = null;
  let taService: TAService | null = null;
  let server: McpServer | null = null;

  try {
    // Load configuration and initialize RelatrService using factory
    const config = loadConfig();
    const services = await RelatrFactory.createRelatrService(config);
    relatrService = services.relatrService;
    taService = services.taService;

    // Create MCP server
    server = new McpServer({
      name: "relatr",
      version: "1.0.0",
    });

    // Register tools
    registerCalculateTrustScoreTool(server, relatrService);
    registerCalculateTrustScoresTool(server, relatrService);
    registerStatsTool(server, relatrService);
    registerSearchProfilesTool(server, relatrService);
    if (taService) {
      registerManageTASubscriptionTool(server, taService);
    }

    // Setup graceful shutdown
    setupGracefulShutdown(relatrService);

    // Start the server
    // const transport = new StdioServerTransport();
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(config.serverSecretKey),
      relayHandler: new ApplesauceRelayPool(config.serverRelays),
      injectClientPubkey: true,
      isPublicServer: config.isPublicServer,
      serverInfo: {
        name: config.serverName,
        about: config.serverAbout,
        website: config.serverWebsite,
        picture: config.serverPicture,
      },
    });
    await server.connect(transport);

    logger.info(
      `Server started successfully with key: ${await transport["getPublicKey"]()}`,
    );
  } catch (error) {
    logger.error("Failed to start server:", error);

    // Cleanup on error
    if (relatrService) {
      try {
        await relatrService.shutdown();
      } catch (shutdownError) {
        logger.error("Error during shutdown cleanup:", shutdownError);
      }
    }

    process.exit(1);
  }
}

/**
 * Register the calculate_trust_score tool
 */
function registerCalculateTrustScoreTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  // Input schema - simplified with only targetPubkey required
  const inputSchema = z.object({
    targetPubkey: z
      .string()
      .min(1, "Target pubkey cannot be empty")
      .refine(
        (value) => validateAndDecodePubkey(value) !== null,
        "Target pubkey must be a valid hex, npub, or nprofile format",
      ),
  });

  // Output schema
  const outputSchema = z.object({
    trustScore: z.object({
      sourcePubkey: z.string(),
      targetPubkey: z.string(),
      score: z.number().min(0).max(1),
      components: z.object({
        distanceWeight: z.number(),
        validators: z.record(z.string(), z.number()),
        socialDistance: z.number(),
        normalizedDistance: z.number(),
      }),
      computedAt: z.number(),
    }),
    computationTimeMs: z.number(),
  });

  server.registerTool(
    "calculate_trust_score",
    {
      title: "Calculate Trust Score",
      description:
        "Compute trust score for a Nostr pubkey using social graph analysis and profile validation. Only target pubkey is required - all other parameters are optional.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      const startTime = Date.now();

      try {
        // Calculate trust score
        const trustScore = await relatrService.calculateTrustScore(params);
        const computationTimeMs = Date.now() - startTime;

        return {
          content: [],
          structuredContent: {
            trustScore: {
              sourcePubkey: trustScore.sourcePubkey,
              targetPubkey: trustScore.targetPubkey,
              score: trustScore.score,
              components: {
                distanceWeight: trustScore.components.distanceWeight,
                validators: trustScore.components.validators,
                socialDistance: trustScore.components.socialDistance,
                normalizedDistance: trustScore.components.normalizedDistance,
              },
              computedAt: trustScore.computedAt,
            },
            computationTimeMs,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error calculating trust score: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the calculate_trust_scores tool (batch)
 */
function registerCalculateTrustScoresTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  const inputSchema = z.object({
    targetPubkeys: z
      .array(z.string().min(1, "Target pubkey cannot be empty"))
      .min(1, "targetPubkeys must contain at least one pubkey"),
  });

  const trustScoreSchema = z.object({
    sourcePubkey: z.string(),
    targetPubkey: z.string(),
    score: z.number().min(0).max(1),
    components: z.object({
      distanceWeight: z.number(),
      validators: z.record(z.string(), z.number()),
      socialDistance: z.number(),
      normalizedDistance: z.number(),
    }),
    computedAt: z.number(),
  });

  const outputSchema = z.object({
    trustScores: z.array(trustScoreSchema),
    computationTimeMs: z.number(),
  });

  server.registerTool(
    "calculate_trust_scores",
    {
      title: "Calculate Trust Scores (Batch)",
      description:
        "Compute trust scores for a list of Nostr pubkeys in one batch using social graph analysis and profile validation.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      const startTime = Date.now();

      try {
        // Deduplicate while preserving first-appearance order.
        // Decode once per input and use decoded hex as canonical identity.
        const seen = new Set<string>();
        const uniqueDecoded: string[] = [];

        for (let i = 0; i < params.targetPubkeys.length; i++) {
          const decoded = validateAndDecodePubkey(params.targetPubkeys[i]!);
          if (!decoded) continue;
          if (seen.has(decoded)) continue;

          seen.add(decoded);
          uniqueDecoded.push(decoded);
        }

        if (uniqueDecoded.length === 0) {
          return {
            content: [],
            structuredContent: {
              trustScores: [],
              computationTimeMs: Date.now() - startTime,
            },
          };
        }

        const trustScoresMap = await relatrService.calculateTrustScoresBatch({
          targetPubkeys: uniqueDecoded,
        });

        const computationTimeMs = Date.now() - startTime;

        // Build results in the same order as uniqueDecoded
        const trustScores = [];
        for (let i = 0; i < uniqueDecoded.length; i++) {
          const decodedHex = uniqueDecoded[i]!;
          const ts = trustScoresMap.get(decodedHex);
          if (ts) {
            trustScores.push({
              sourcePubkey: ts.sourcePubkey,
              targetPubkey: ts.targetPubkey,
              score: ts.score,
              components: {
                distanceWeight: ts.components.distanceWeight,
                validators: ts.components.validators,
                socialDistance: ts.components.socialDistance,
                normalizedDistance: ts.components.normalizedDistance,
              },
              computedAt: ts.computedAt,
            });
          }
        }

        return {
          content: [],
          structuredContent: {
            trustScores,
            computationTimeMs,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error calculating trust scores: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the stats tool
 */
function registerStatsTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  // Input schema (empty)
  const inputSchema = z.object({});

  // Output schema
  const outputSchema = z.object({
    timestamp: z.number(),
    sourcePubkey: z.string(),
    database: z.object({
      metrics: z.object({
        totalEntries: z.number(),
      }),
      metadata: z.object({
        totalEntries: z.number(),
      }),
    }),
    socialGraph: z.object({
      stats: z.object({
        users: z.number(),
        follows: z.number(),
      }),
      rootPubkey: z.string(),
    }),
  });

  server.registerTool(
    "stats",
    {
      title: "Stats",
      description:
        "Get comprehensive statistics about the Relatr service including database stats, social graph stats, and the source public key",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async () => {
      try {
        const statsResult = await relatrService.getStats();

        return {
          content: [],
          structuredContent: {
            timestamp: statsResult.timestamp,
            sourcePubkey: statsResult.sourcePubkey,
            database: {
              metrics: statsResult.database.metrics,
              metadata: statsResult.database.metadata,
            },
            socialGraph: {
              stats: statsResult.socialGraph.stats,
              rootPubkey: statsResult.socialGraph.rootPubkey,
            },
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error getting stats: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the search_profiles tool
 */
function registerSearchProfilesTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  // Input schema
  const inputSchema = z.object({
    query: z
      .string()
      .min(1, "Search query cannot be empty")
      .max(100, "Search query too long (max 100 characters)"),
    limit: z
      .number()
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(50, "Limit cannot exceed 50")
      .optional()
      .default(7)
      .describe("Maximum number of results to return (default: 20)"),
    extendToNostr: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Whether to extend the search to Nostr to fill remaining results. Defaults to false. If false, Nostr will only be queried when local DB returns zero results.",
      ),
  });

  // Output schema
  const outputSchema = z.object({
    results: z.array(
      z.object({
        pubkey: z.string(),
        trustScore: z.number().min(0).max(1),
        rank: z.number().int().min(1),
        exactMatch: z.boolean().optional(),
      }),
    ),
    totalFound: z.number().int().min(0),
    searchTimeMs: z.number().int().min(0),
  });

  server.registerTool(
    "search_profiles",
    {
      title: "Search Profiles",
      description:
        "Search for Nostr profiles by name/query and return results sorted by trust score. Queries metadata relays and calculates trust scores for each result.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      try {
        // Search profiles - pass through the extendToNostr flag (if provided)
        const searchResult = await relatrService.searchProfiles(params);
        const result = {
          results: searchResult.results.map((result: SearchProfileResult) => ({
            pubkey: result.pubkey,
            trustScore: result.trustScore,
            rank: result.rank,
            exactMatch: result.exactMatch,
          })),
          totalFound: searchResult.totalFound,
          searchTimeMs: searchResult.searchTimeMs,
        };

        return {
          content: [],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error searching profiles: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the manage_ta_subscription tool
 */
function registerManageTASubscriptionTool(
  server: McpServer,
  taService: TAService,
): void {
  // Input schema with action parameter
  const inputSchema = z.object({
    action: z
      .enum(["get", "subscribe", "unsubscribe"])
      .describe(
        "Action to perform: 'get' to check status, 'subscribe' to activate, 'unsubscribe' to deactivate",
      ),
    customRelays: z
      .string()
      .optional()
      .describe(
        "Optional comma-separated list of custom relay URLs to publish TA events to (only used for subscribe action)",
      ),
  });

  // Output schema - unified response from manageTASub
  const outputSchema = z.object({
    success: z.boolean(),
    message: z.string().optional(),
    subscriberPubkey: z.string(),
    isActive: z.boolean(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
    rank: z
      .object({
        published: z.boolean(),
        rank: z.number(),
        previousRank: z.number().nullable(),
        relayResults: z
          .array(
            z.object({
              ok: z.boolean(),
              message: z.string().optional(),
              from: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
  });

  server.registerTool(
    "manage_ta_subscription",
    {
      title: "Manage TA Subscription",
      description:
        "Manage your Trusted Assertions subscription. Check status, subscribe, or unsubscribe from TA services.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params, { _meta }) => {
      // Extract client pubkey from _meta (injected by CEP-16)
      // NOTE: This is always hex when using NostrServerTransport with injectClientPubkey=true.
      const clientPubkey = _meta?.clientPubkey;

      if (!clientPubkey || typeof clientPubkey !== "string") {
        return {
          content: [],
          structuredContent: {
            success: false,
            message: "Client public key not available",
            subscriberPubkey: "",
            isActive: false,
            createdAt: null,
            updatedAt: null,
          },
          isError: true,
        };
      }

      try {
        // Validate input
        const action = params.action;
        const customRelays = params.customRelays
          ? relaySet(params.customRelays.split(",").map((url) => url.trim()))
          : undefined;

        const result = await taService.manageTASub(
          action,
          clientPubkey,
          customRelays,
        );

        return {
          content: [],
          structuredContent: {
            success: result.success,
            message: result.message,
            subscriberPubkey: result.subscriberPubkey,
            isActive: result.isActive,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
            rank: result.rank,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [],
          structuredContent: {
            success: false,
            message: errorMessage,
            subscriberPubkey: clientPubkey,
            isActive: false,
            createdAt: null,
            updatedAt: null,
          },
          isError: true,
        };
      }
    },
  );
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(relatrService: RelatrService): void {
  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      // Shutdown RelatrService
      await relatrService.shutdown();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled rejection at:", promise, "reason:", reason);
    gracefulShutdown("unhandledRejection");
  });
}

// Start the server if this file is run directly
if (import.meta.main) {
  startMCPServer().catch((error) => {
    logger.error("Fatal error:", error);
    process.exit(1);
  });
}
