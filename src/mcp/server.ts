import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RelatrService } from "../service/RelatrService.js";
import { loadConfig } from "../config.js";
import {
  ApplesauceRelayPool,
  NostrServerTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

/**
 * Start the MCP server for Relatr
 *
 * This function initializes the RelatrService, creates and configures the MCP server,
 * registers the required tools, and handles graceful shutdown.
 */
export async function startMCPServer(): Promise<void> {
  let relatrService: RelatrService | null = null;
  let server: McpServer | null = null;

  try {
    // Load configuration and initialize RelatrService
    const config = loadConfig();
    relatrService = new RelatrService(config);
    await relatrService.initialize();

    // Create MCP server
    server = new McpServer({
      name: "relatr",
      version: "1.0.0",
    });

    // Register tools
    registerCalculateTrustScoreTool(server, relatrService);
    registerStatsTool(server, relatrService);
    registerSearchProfilesTool(server, relatrService);

    // Setup graceful shutdown
    setupGracefulShutdown(relatrService);

    // Start the server
    // const transport = new StdioServerTransport();
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(config.serverSecretKey),
      relayHandler: new ApplesauceRelayPool(config.serverRelays),
    });
    await server.connect(transport);

    console.error("[Relatr MCP] Server started successfully");
    console.error(
      "[Relatr MCP] With key:",
      getPublicKey(hexToBytes(config.serverSecretKey)),
    );
  } catch (error) {
    console.error("[Relatr MCP] Failed to start server:", error);

    // Cleanup on error
    if (relatrService) {
      try {
        await relatrService.shutdown();
      } catch (shutdownError) {
        console.error(
          "[Relatr MCP] Error during shutdown cleanup:",
          shutdownError,
        );
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
      .length(64, "Target pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Target pubkey must be a valid hex string"),
    weightingScheme: z
      .enum(["default", "social", "validation", "strict"])
      .optional()
      .describe(
        "Weighting scheme: 'default' (balanced), 'conservative' (higher profile validation), 'progressive' (higher social distance), 'balanced'",
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
        // Validate input
        const validatedParams = inputSchema.parse(params);

        // Calculate trust score
        const trustScore =
          await relatrService.calculateTrustScore(validatedParams);
        const computationTimeMs = Date.now() - startTime;

        const result = {
          trustScore,
          computationTimeMs,
        };

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
    weightingScheme: z
      .enum(["default", "social", "validation", "strict"])
      .optional()
      .describe(
        "Weighting scheme: 'default' (balanced), 'social' (higher social distance), 'validation' (higher profile validation), 'strict' (highest requirements)",
      ),
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
        // Validate input
        const validatedParams = inputSchema.parse(params);

        // Search profiles - pass through the extendToNostr flag (if provided)
        const searchResult =
          await relatrService.searchProfiles(validatedParams);
        const result = {
          results: searchResult.results.map((result) => ({
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
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(relatrService: RelatrService): void {
  const gracefulShutdown = async (signal: string): Promise<void> => {
    console.error(
      `[Relatr MCP] Received ${signal}, shutting down gracefully...`,
    );

    try {
      // Shutdown RelatrService
      await relatrService.shutdown();
      console.error("[Relatr MCP] Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("[Relatr MCP] Error during shutdown:", error);
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[Relatr MCP] Uncaught exception:", error);
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error(
      "[Relatr MCP] Unhandled rejection at:",
      promise,
      "reason:",
      reason,
    );
    gracefulShutdown("unhandledRejection");
  });
}

// Start the server if this file is run directly
if (import.meta.main) {
  startMCPServer().catch((error) => {
    console.error("[Relatr MCP] Fatal error:", error);
    process.exit(1);
  });
}
