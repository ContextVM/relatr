import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RelatrService } from '../service/RelatrService.js';
import { loadConfig } from '../config.js';

/**
 * Start the MCP server for Relatr v2
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
            name: 'relatr-v2',
            version: '2.0.0'
        });

        // Register tools
        registerCalculateTrustScoreTool(server, relatrService);
        registerHealthCheckTool(server, relatrService);
        registerManageCacheTool(server, relatrService);

        // Setup graceful shutdown
        setupGracefulShutdown(server, relatrService);

        // Start the server
        const transport = new StdioServerTransport();
        await server.connect(transport);
        
        console.log('[Relatr MCP] Server started successfully');

    } catch (error) {
        console.error('[Relatr MCP] Failed to start server:', error);
        
        // Cleanup on error
        if (relatrService) {
            try {
                await relatrService.shutdown();
            } catch (shutdownError) {
                console.error('[Relatr MCP] Error during shutdown cleanup:', shutdownError);
            }
        }
        
        process.exit(1);
    }
}

/**
 * Register the calculate_trust_score tool
 */
function registerCalculateTrustScoreTool(server: McpServer, relatrService: RelatrService): void {
    // Input schema
    const inputSchema = z.object({
        sourcePubkey: z.string()
            .length(64, "Source pubkey must be exactly 64 characters (hex)")
            .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
            .optional(),
        targetPubkey: z.string()
            .length(64, "Target pubkey must be exactly 64 characters (hex)")
            .regex(/^[0-9a-fA-F]+$/, "Target pubkey must be a valid hex string"),
        weightingScheme: z.enum(['default', 'conservative', 'progressive', 'balanced'])
            .optional(),
        customWeights: z.object({
            distanceWeight: z.number().min(0).max(1).optional(),
            nip05Valid: z.number().min(0).max(1).optional(),
            lightningAddress: z.number().min(0).max(1).optional(),
            eventKind10002: z.number().min(0).max(1).optional(),
            reciprocity: z.number().min(0).max(1).optional(),
        }).optional()
    });

    // Output schema
    const outputSchema = z.object({
        trustScore: z.object({
            sourcePubkey: z.string(),
            targetPubkey: z.string(),
            score: z.number().min(0).max(1),
            components: z.object({
                distanceWeight: z.number(),
                nip05Valid: z.number(),
                lightningAddress: z.number(),
                eventKind10002: z.number(),
                reciprocity: z.number(),
                socialDistance: z.number(),
                normalizedDistance: z.number(),
            }),
            computedAt: z.number(),
        }),
        computationTimeMs: z.number(),
    });

    server.registerTool(
        'calculate_trust_score',
        {
            title: 'Calculate Trust Score',
            description: 'Compute trust score between two Nostr pubkeys using social graph distance and profile metrics',
            inputSchema: inputSchema.shape,
            outputSchema: outputSchema.shape,
        },
        async (params) => {
            const startTime = Date.now();
            
            try {
                // Validate input
                const validatedParams = inputSchema.parse(params);
                
                // Calculate trust score
                const trustScore = await relatrService.calculateTrustScore(validatedParams);
                const computationTimeMs = Date.now() - startTime;
                
                const result = {
                    trustScore,
                    computationTimeMs,
                };
                
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }],
                    structuredContent: {
                        trustScore: {
                            sourcePubkey: trustScore.sourcePubkey,
                            targetPubkey: trustScore.targetPubkey,
                            score: trustScore.score,
                            components: {
                                distanceWeight: trustScore.components.distanceWeight,
                                nip05Valid: trustScore.components.nip05Valid,
                                lightningAddress: trustScore.components.lightningAddress,
                                eventKind10002: trustScore.components.eventKind10002,
                                reciprocity: trustScore.components.reciprocity,
                                socialDistance: trustScore.components.socialDistance,
                                normalizedDistance: trustScore.components.normalizedDistance,
                            },
                            computedAt: trustScore.computedAt,
                        },
                        computationTimeMs,
                    },
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                return {
                    content: [{
                        type: 'text',
                        text: `Error calculating trust score: ${errorMessage}`
                    }],
                    isError: true,
                };
            }
        }
    );
}

/**
 * Register the health_check tool
 */
function registerHealthCheckTool(server: McpServer, relatrService: RelatrService): void {
    // Input schema (empty)
    const inputSchema = z.object({});

    // Output schema
    const outputSchema = z.object({
        status: z.enum(['healthy', 'unhealthy']),
        database: z.boolean(),
        socialGraph: z.boolean(),
        timestamp: z.number(),
    });

    server.registerTool(
        'health_check',
        {
            title: 'Health Check',
            description: 'Check the health status of the Relatr service',
            inputSchema: inputSchema.shape,
            outputSchema: outputSchema.shape,
        },
        async () => {
            try {
                const healthResult = await relatrService.healthCheck();
                
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(healthResult, null, 2)
                    }],
                    structuredContent: {
                        status: healthResult.status,
                        database: healthResult.database,
                        socialGraph: healthResult.socialGraph,
                        timestamp: healthResult.timestamp,
                    },
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                return {
                    content: [{
                        type: 'text',
                        text: `Error during health check: ${errorMessage}`
                    }],
                    isError: true,
                };
            }
        }
    );
}

/**
 * Register the manage_cache tool
 */
function registerManageCacheTool(server: McpServer, relatrService: RelatrService): void {
    // Input schema
    const inputSchema = z.object({
        action: z.enum(['clear', 'cleanup', 'stats']),
        targetPubkey: z.string()
            .length(64, "Target pubkey must be exactly 64 characters (hex)")
            .regex(/^[0-9a-fA-F]+$/, "Target pubkey must be a valid hex string")
            .optional(),
    });

    // Output schema
    const outputSchema = z.object({
        success: z.boolean(),
        metricsCleared: z.number().optional(),
        scoresCleared: z.number().optional(),
        message: z.string(),
    });

    server.registerTool(
        'manage_cache',
        {
            title: 'Manage Cache',
            description: 'Manage cache operations (clear, cleanup, stats)',
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
                    validatedParams.targetPubkey
                );
                
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }],
                    structuredContent: {
                        success: result.success,
                        metricsCleared: result.metricsCleared,
                        scoresCleared: result.scoresCleared,
                        message: result.message,
                    },
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                return {
                    content: [{
                        type: 'text',
                        text: `Error managing cache: ${errorMessage}`
                    }],
                    isError: true,
                };
            }
        }
    );
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(server: McpServer, relatrService: RelatrService): void {
    const gracefulShutdown = async (signal: string): Promise<void> => {
        console.log(`[Relatr MCP] Received ${signal}, shutting down gracefully...`);
        
        try {
            // Shutdown RelatrService
            await relatrService.shutdown();
            console.log('[Relatr MCP] Shutdown complete');
            process.exit(0);
        } catch (error) {
            console.error('[Relatr MCP] Error during shutdown:', error);
            process.exit(1);
        }
    };

    // Register signal handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[Relatr MCP] Uncaught exception:', error);
        gracefulShutdown('uncaughtException');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Relatr MCP] Unhandled rejection at:', promise, 'reason:', reason);
        gracefulShutdown('unhandledRejection');
    });
}

// Start the server if this file is run directly
if (import.meta.main) {
    startMCPServer().catch((error) => {
        console.error('[Relatr MCP] Fatal error:', error);
        process.exit(1);
    });
}