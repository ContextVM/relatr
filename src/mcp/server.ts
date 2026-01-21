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
import { RelatrError, type SearchProfileResult } from "../types.js";
import { logger } from "../utils/Logger.js";
import { relaySet } from "applesauce-core/helpers";
import { RateLimiter } from "./RateLimiter.js";
import { nowMs } from "@/utils/utils.js";

/**
 * Start MCP server for Relatr
 *
 * This function initializes RelatrService, creates and configures MCP server,
 * registers required tools, and handles graceful shutdown.
 */
export async function startMCPServer(): Promise<void> {
  let relatrService: RelatrService | null = null;
  let taService: TAService | null = null;
  let server: McpServer | null = null;
  let rateLimiter: RateLimiter | null = null;

  try {
    // Load configuration and initialize RelatrService using factory
    const config = loadConfig();
    const services = await RelatrFactory.createRelatrService(config);
    relatrService = services.relatrService;
    taService = services.taService;

    // Initialize rate limiter
    rateLimiter = new RateLimiter(
      config.rateLimitTokens,
      config.rateLimitRefillRate,
    );
    logger.info(
      `Rate limiter initialized: ${config.rateLimitTokens} tokens, ${config.rateLimitRefillRate}/sec refill`,
    );

    // Create MCP server
    server = new McpServer({
      name: "relatr",
      version: "1.0.0",
    });

    // Register tools with rate limiter
    registerCalculateTrustScoreTool(server, relatrService, rateLimiter);
    registerCalculateTrustScoresTool(server, relatrService, rateLimiter);
    registerStatsTool(server, relatrService, rateLimiter);
    registerSearchProfilesTool(server, relatrService, rateLimiter);
    if (taService) {
      registerManageTATool(server, taService, rateLimiter);
    }

    // Setup graceful shutdown
    setupGracefulShutdown(relatrService);

    // Start server
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
 * Rate-limited wrapper for tool handlers
 */
async function withRateLimit<T>(
  rateLimiter: RateLimiter,
  toolName: string,
  handler: () => Promise<T>,
): Promise<T> {
  if (!rateLimiter.acquire()) {
    throw new RelatrError(
      `Rate limit exceeded for ${toolName}. Try again later.`,
      "RATE_LIMIT_EXCEEDED",
    );
  }
  return handler();
}

/**
 * Convert an error to an MCP response
 * Centralized error mapping for all tool handlers
 */
function toMcpResponse(
  error: unknown,
  toolName: string,
  clientPubkey?: string,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
} {
  if (error instanceof RelatrError && error.code === "RATE_LIMIT_EXCEEDED") {
    return {
      content: [
        {
          type: "text",
          text: error.message,
        },
      ],
      isError: true,
    };
  }

  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  if (toolName === "manage_ta" && clientPubkey) {
    return {
      content: [],
      structuredContent: {
        success: false,
        message: errorMessage,
        pubkey: clientPubkey,
        isActive: false,
        createdAt: null,
        computedAt: null,
      },
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Error ${toolName}: ${errorMessage}`,
      },
    ],
    isError: true,
  };
}

/**
 * Register the calculate_trust_score tool
 */
function registerCalculateTrustScoreTool(
  server: McpServer,
  relatrService: RelatrService,
  rateLimiter: RateLimiter,
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
        validators: z.record(
          z.string(),
          z.object({
            score: z.number(),
            description: z.string().optional(),
          }),
        ),
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
      const startTime = nowMs();

      try {
        const trustScore = await withRateLimit(
          rateLimiter,
          "calculate_trust_score",
          () => relatrService.calculateTrustScore(params),
        );
        const computationTimeMs = nowMs() - startTime;

        return {
          content: [],
          structuredContent: {
            trustScore,
            computationTimeMs,
          },
        };
      } catch (error) {
        return toMcpResponse(error, "calculate_trust_score");
      }
    },
  );
}

/**
 * Register calculate_trust_scores tool (batch)
 */
function registerCalculateTrustScoresTool(
  server: McpServer,
  relatrService: RelatrService,
  rateLimiter: RateLimiter,
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
      validators: z.record(
        z.string(),
        z.object({
          score: z.number(),
          description: z.string().optional(),
        }),
      ),
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
      const startTime = nowMs();

      try {
        const trustScoresMap = await withRateLimit(
          rateLimiter,
          "calculate_trust_scores",
          async () => {
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
              return new Map<
                string,
                ReturnType<typeof relatrService.calculateTrustScore>
              >();
            }

            return await relatrService.calculateTrustScoresBatch({
              targetPubkeys: uniqueDecoded,
            });
          },
        );

        if (trustScoresMap instanceof Map && trustScoresMap.size === 0) {
          return {
            content: [],
            structuredContent: {
              trustScores: [],
              computationTimeMs: nowMs() - startTime,
            },
          };
        }

        const computationTimeMs = nowMs() - startTime;

        const trustScores = [];
        for (let i = 0; i < params.targetPubkeys.length; i++) {
          const decoded = validateAndDecodePubkey(params.targetPubkeys[i]!);
          if (!decoded) continue;
          const ts = await trustScoresMap.get(decoded);
          if (ts) {
            trustScores.push(ts);
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
        return toMcpResponse(error, "calculate_trust_scores");
      }
    },
  );
}

/**
 * Register stats tool
 */
function registerStatsTool(
  server: McpServer,
  relatrService: RelatrService,
  rateLimiter: RateLimiter,
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
        "Get comprehensive statistics about Relatr service including database stats, social graph stats, and source public key",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async () => {
      try {
        const statsResult = await withRateLimit(rateLimiter, "stats", () =>
          relatrService.getStats(),
        );

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
        return toMcpResponse(error, "stats");
      }
    },
  );
}

/**
 * Register search_profiles tool
 */
function registerSearchProfilesTool(
  server: McpServer,
  relatrService: RelatrService,
  rateLimiter: RateLimiter,
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
        "Whether to extend search to Nostr to fill remaining results. Defaults to false. If false, Nostr will only be queried when local DB returns zero results.",
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
        const searchResult = await withRateLimit(
          rateLimiter,
          "search_profiles",
          () => relatrService.searchProfiles(params),
        );
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
        return toMcpResponse(error, "search_profiles");
      }
    },
  );
}

/**
 * Register manage_ta tool
 */
function registerManageTATool(
  server: McpServer,
  taService: TAService,
  rateLimiter: RateLimiter,
): void {
  // Input schema with action parameter
  const inputSchema = z.object({
    action: z
      .enum(["get", "enable", "disable"])
      .describe(
        "Action to perform: 'get' to check status, 'enable' to activate, 'disable' to deactivate",
      ),
    customRelays: z
      .string()
      .optional()
      .describe(
        "Optional comma-separated list of custom relay URLs to publish TA events to (only used for enable action)",
      ),
  });

  // Output schema - unified response from manageTASub
  const outputSchema = z.object({
    success: z.boolean(),
    message: z.string().optional(),
    pubkey: z.string(),
    isActive: z.boolean(),
    createdAt: z.number().nullable(),
    computedAt: z.number().nullable(),
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
    "manage_ta",
    {
      title: "Manage TA",
      description:
        "Manage your Trusted Assertions. Check status, enable, or disable TA entries.",
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
            pubkey: "",
            isActive: false,
            createdAt: null,
            computedAt: null,
          },
          isError: true,
        };
      }

      try {
        // Apply rate limiting
        const result = await withRateLimit(
          rateLimiter,
          "manage_ta",
          async () => {
            // Validate input
            const action = params.action;
            const customRelays = params.customRelays
              ? relaySet(
                  params.customRelays.split(",").map((url) => url.trim()),
                )
              : undefined;

            return await taService.manageTASub(
              action,
              clientPubkey,
              customRelays,
            );
          },
        );

        return {
          content: [],
          structuredContent: {
            success: result.success,
            message: result.message,
            pubkey: result.pubkey,
            isActive: result.isActive,
            createdAt: result.createdAt,
            computedAt: result.computedAt,
            rank: result.rank,
          },
        };
      } catch (error) {
        return toMcpResponse(error, "manage_ta", clientPubkey);
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
