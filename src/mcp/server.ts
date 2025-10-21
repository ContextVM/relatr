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
    registerHealthCheckTool(server, relatrService);
    registerManageCacheTool(server, relatrService);
    registerSearchProfilesTool(server, relatrService);
    registerFetchContactsTool(server, relatrService);
    registerFetchMetadataTool(server, relatrService);

    // Setup graceful shutdown
    setupGracefulShutdown(relatrService);

    // Start the server
    // const transport = new StdioServerTransport();
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(config.serverSecretKey),
      relayHandler: new ApplesauceRelayPool(
        config.serverRelays.length > 0
          ? config.serverRelays
          : ["ws://localhost:10547"],
      ),
    });
    await server.connect(transport);

    console.error("[Relatr MCP] Server started successfully");
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
    sourcePubkey: z
      .string()
      .length(64, "Source pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
      .optional()
      .describe("Optional source pubkey (uses default if not provided)"),
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
        validators: z.object({
          nip05Valid: z.number(),
          lightningAddress: z.number(),
          eventKind10002: z.number(),
          reciprocity: z.number(),
          isRootNip05: z.number(),
        }),
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
 * Register the health_check tool
 */
function registerHealthCheckTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  // Input schema (empty)
  const inputSchema = z.object({});

  // Output schema
  const outputSchema = z.object({
    status: z.enum(["healthy", "unhealthy"]),
    database: z.boolean(),
    socialGraph: z.boolean(),
    timestamp: z.number(),
  });

  server.registerTool(
    "health_check",
    {
      title: "Health Check",
      description: "Check the health status of the Relatr service",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async () => {
      try {
        const healthResult = await relatrService.healthCheck();

        return {
          content: [],
          structuredContent: {
            status: healthResult.status,
            database: healthResult.database,
            socialGraph: healthResult.socialGraph,
            timestamp: healthResult.timestamp,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error during health check: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the manage_cache tool
 */
function registerManageCacheTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  // Input schema
  const inputSchema = z.object({
    action: z.enum(["clear", "cleanup", "stats"]),
    targetPubkey: z
      .string()
      .length(64, "Target pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Target pubkey must be a valid hex string")
      .optional(),
  });

  // Output schema
  const outputSchema = z.object({
    success: z.boolean(),
    metricsCleared: z.number().optional(),
    message: z.string(),
  });

  server.registerTool(
    "manage_cache",
    {
      title: "Manage Cache",
      description: "Manage cache operations (clear, cleanup, stats)",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      try {
        // Validate input
        const validatedParams = inputSchema.parse(params);

        // Execute cache operation
        const result = await relatrService.manageCache(
          validatedParams.action,
          validatedParams.targetPubkey,
        );

        return {
          content: [],
          structuredContent: {
            success: result.success,
            metricsCleared: result.metricsCleared,
            message: result.message,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Error managing cache: ${errorMessage}`,
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
    sourcePubkey: z
      .string()
      .length(64, "Source pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
      .optional()
      .describe(
        "Optional source pubkey for trust score calculation (uses default if not provided)",
      ),
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
 * Register the fetch_contacts tool
 */
function registerFetchContactsTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  const inputSchema = z.object({
    sourcePubkey: z
      .string()
      .length(64, "Source pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
      .optional()
      .describe("Optional source pubkey (uses default if not provided)"),
    hops: z
      .number()
      .int("Hops must be an integer")
      .min(0, "Hops cannot be negative")
      .max(5, "Hops cannot exceed 5")
      .optional()
      .default(1)
      .describe("Number of hops to traverse in the social graph (0-5, default: 1)"),
  });

  const outputSchema = z.object({
    success: z.boolean(),
    eventsFetched: z.number(),
    message: z.string(),
  });

  server.registerTool(
    "fetch_contacts",
    {
      title: "Fetch Nostr Contacts",
      description:
        "Fetches kind 3 events (contact lists) from Nostr for a given pubkey and its social graph hops to build the social graph.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      try {
        const validatedParams = inputSchema.parse(params);
        const result = await relatrService.fetchNostrEvents({
          ...validatedParams,
          kind: 3,
        });
        return {
          content: [],
          structuredContent: {
            success: result.success,
            eventsFetched: result.eventsFetched,
            message: result.message,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Error fetching contacts: ${errorMessage}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the fetch_metadata tool
 */
function registerFetchMetadataTool(
  server: McpServer,
  relatrService: RelatrService,
): void {
  const inputSchema = z.object({
    sourcePubkey: z
      .string()
      .length(64, "Source pubkey must be exactly 64 characters (hex)")
      .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
      .optional()
      .describe("Optional source pubkey (uses default if not provided)"),
    hops: z
      .number()
      .int("Hops must be an integer")
      .min(0, "Hops cannot be negative")
      .max(5, "Hops cannot exceed 5")
      .optional()
      .default(1)
      .describe("Number of hops to traverse in the social graph (0-5, default: 1)"),
  });

  const outputSchema = z.object({
    success: z.boolean(),
    eventsFetched: z.number(),
    message: z.string(),
  });

  server.registerTool(
    "fetch_metadata",
    {
      title: "Fetch Nostr Metadata",
      description:
        "Fetches kind 0 events (profile metadata) from Nostr for a given pubkey and its social graph hops, populating the local cache.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
    },
    async (params) => {
      try {
        console.error("FETCHING METADATA");
        const validatedParams = inputSchema.parse(params);
        const result = await relatrService.fetchNostrEvents({
          ...validatedParams,
          kind: 0,
        });
        return {
          content: [],
          structuredContent: {
            success: result.success,
            eventsFetched: result.eventsFetched,
            message: result.message,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Error fetching metadata: ${errorMessage}` }],
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
