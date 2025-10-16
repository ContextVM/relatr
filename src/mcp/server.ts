import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RelatrService } from '../services/RelatrService.js';
import { config } from '../config/environment.js';
import type { TrustScoreCalculationRequest } from '../services/types.js';

/**
 * MCP Server for Relatr trust score calculation
 * 
 * This server exposes the `calculate_trust_score` tool that computes trust scores
 * between Nostr pubkeys based on social graph distance and profile metrics.
 */
class RelatrMcpServer {
    private server: McpServer;
    private relatrService: RelatrService;
    private isInitialized = false;
    private isShuttingDown = false;

    constructor() {
        this.server = new McpServer({
            name: 'relatr',
            version: '1.0.0'
        });

        this.relatrService = new RelatrService({
            defaultSourcePubkey: config.DEFAULT_SOURCE_PUBKEY,
            enableLogging: true,
            logLevel: 'info',
            enableMetrics: true,
            performanceMonitoring: true,
        });

        this.setupSignalHandlers();
    }

    /**
     * Initialize the MCP server and all dependencies
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            console.log('[RelatrMcpServer] Already initialized');
            return;
        }

        console.log('[RelatrMcpServer] Initializing Relatr MCP Server...');

        try {
            // Initialize the RelatrService
            await this.relatrService.initialize();
            
            // Register tools
            this.registerTools();
            
            // Register server info
            this.registerServerInfo();
            
            this.isInitialized = true;
            console.log('[RelatrMcpServer] MCP Server initialized successfully');
            
        } catch (error) {
            console.error('[RelatrMcpServer] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Register all MCP tools
     */
    private registerTools(): void {
        // Register calculate_trust_score tool
        this.server.registerTool(
            'calculate_trust_score',
            {
                title: 'Calculate Trust Score',
                description: 'Compute trust score between two Nostr pubkeys using social graph distance and profile metrics',
                inputSchema: {
                    targetPubkey: z.string()
                        .length(64, "Target pubkey must be exactly 64 characters (hex)")
                        .regex(/^[0-9a-fA-F]+$/, "Target pubkey must be a valid hex string"),
                    sourcePubkey: z.string()
                        .length(64, "Source pubkey must be exactly 64 characters (hex)")
                        .regex(/^[0-9a-fA-F]+$/, "Source pubkey must be a valid hex string")
                        .optional(),
                    scheme: z.enum(['default', 'conservative', 'progressive', 'balanced'], {
                        errorMap: () => ({ message: "Scheme must be one of: default, conservative, progressive, balanced" })
                    }).optional(),
                    forceRefresh: z.boolean().optional(),
                },
            },
            async (params) => {
                return this.handleCalculateTrustScore(params);
            }
        );

        // Register health check tool
        this.server.registerTool(
            'health_check',
            {
                title: 'Health Check',
                description: 'Check the health status of the Relatr service',
                inputSchema: {},
            },
            async () => {
                return this.handleHealthCheck();
            }
        );

        // Register cache management tool
        this.server.registerTool(
            'manage_cache',
            {
                title: 'Manage Cache',
                description: 'Manage cache operations (cleanup, invalidate)',
                inputSchema: {
                    operation: z.enum(['cleanup', 'invalidate']),
                    targetPubkey: z.string().optional(),
                },
            },
            async (params) => {
                return this.handleCacheManagement(params);
            }
        );

        console.log('[RelatrMcpServer] Tools registered successfully');
    }

    /**
     * Register server information
     */
    private registerServerInfo(): void {
        // Server info is automatically handled by the MCP SDK
        // No need to manually register request handlers
    }

    /**
     * Handle calculate_trust_score tool requests
     */
    private async handleCalculateTrustScore(params: any): Promise<any> {
        if (this.isShuttingDown) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: Server is shutting down'
                }],
                isError: true,
            };
        }

        try {
            // Validate input parameters manually since we can't use Zod schema directly
            if (!params.targetPubkey || typeof params.targetPubkey !== 'string') {
                throw new Error('targetPubkey is required and must be a string');
            }
            
            if (!/^[0-9a-fA-F]{64}$/.test(params.targetPubkey)) {
                throw new Error('targetPubkey must be exactly 64 hex characters');
            }
            
            if (params.sourcePubkey && !/^[0-9a-fA-F]{64}$/.test(params.sourcePubkey)) {
                throw new Error('sourcePubkey must be exactly 64 hex characters');
            }
            
            if (params.scheme && !['default', 'conservative', 'progressive', 'balanced'].includes(params.scheme)) {
                throw new Error('scheme must be one of: default, conservative, progressive, balanced');
            }
            
            // Prepare request for RelatrService
            const request: TrustScoreCalculationRequest = {
                targetPubkey: params.targetPubkey,
                sourcePubkey: params.sourcePubkey || config.DEFAULT_SOURCE_PUBKEY,
                scheme: params.scheme || 'default',
                forceRefresh: params.forceRefresh || false,
            };

            console.log(`[RelatrMcpServer] Calculating trust score for ${request.targetPubkey.substring(0, 8)}... from ${request.sourcePubkey?.substring(0, 8)}...`);

            // Calculate trust score using RelatrService
            const result = await this.relatrService.calculateTrustScore(request);

            console.log(`[RelatrMcpServer] Trust score calculated: ${result.score.toFixed(3)} (${result.duration}ms)`);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                }],
                structuredContent: result,
            };

        } catch (error) {
            console.error('[RelatrMcpServer] Error calculating trust score:', error);
            
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

    /**
     * Handle health check requests
     */
    private async handleHealthCheck(): Promise<any> {
        try {
            const healthStatus = await this.relatrService.getHealthStatus();
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(healthStatus, null, 2)
                }],
                structuredContent: healthStatus,
            };

        } catch (error) {
            console.error('[RelatrMcpServer] Error during health check:', error);
            
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

    /**
     * Handle cache management requests
     */
    private async handleCacheManagement(params: any): Promise<any> {
        try {
            const { operation, targetPubkey } = params;
            
            if (operation === 'cleanup') {
                const cleanedEntries = await this.relatrService.cleanupCaches();
                
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Cache cleanup completed`,
                            cleanedEntries,
                        }, null, 2)
                    }],
                    structuredContent: {
                        success: true,
                        message: `Cache cleanup completed`,
                        cleanedEntries,
                    },
                };
            } else if (operation === 'invalidate') {
                if (!targetPubkey) {
                    throw new Error('targetPubkey is required for invalidate operation');
                }
                
                await this.relatrService.invalidateCache(targetPubkey);
                
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            message: `Cache invalidated for ${targetPubkey.substring(0, 8)}...`,
                        }, null, 2)
                    }],
                    structuredContent: {
                        success: true,
                        message: `Cache invalidated for ${targetPubkey.substring(0, 8)}...`,
                    },
                };
            } else {
                throw new Error(`Unknown operation: ${operation}`);
            }

        } catch (error) {
            console.error('[RelatrMcpServer] Error managing cache:', error);
            
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

    /**
     * Start the MCP server
     */
    async start(): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        console.log('[RelatrMcpServer] Starting MCP server on stdio...');

        try {
            const transport = new StdioServerTransport();
            await this.server.connect(transport);
            
            console.log('[RelatrMcpServer] MCP server started successfully');
            
        } catch (error) {
            console.error('[RelatrMcpServer] Failed to start MCP server:', error);
            throw error;
        }
    }

    /**
     * Gracefully shutdown the server
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) {
            console.log('[RelatrMcpServer] Already shutting down');
            return;
        }

        this.isShuttingDown = true;
        console.log('[RelatrMcpServer] Shutting down MCP server...');

        try {
            // Shutdown RelatrService
            if (this.relatrService) {
                await this.relatrService.shutdown();
            }

            console.log('[RelatrMcpServer] MCP server shutdown complete');
            
        } catch (error) {
            console.error('[RelatrMcpServer] Error during shutdown:', error);
            throw error;
        }
    }

    /**
     * Setup signal handlers for graceful shutdown
     */
    private setupSignalHandlers(): void {
        const gracefulShutdown = async (signal: string) => {
            console.log(`[RelatrMcpServer] Received ${signal}, initiating graceful shutdown...`);
            
            try {
                await this.shutdown();
                process.exit(0);
            } catch (error) {
                console.error('[RelatrMcpServer] Error during graceful shutdown:', error);
                process.exit(1);
            }
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('[RelatrMcpServer] Uncaught exception:', error);
            gracefulShutdown('uncaughtException');
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            console.error('[RelatrMcpServer] Unhandled rejection at:', promise, 'reason:', reason);
            gracefulShutdown('unhandledRejection');
        });
    }
}

/**
 * Main entry point for the MCP server
 */
async function main(): Promise<void> {
    const server = new RelatrMcpServer();
    
    try {
        await server.start();
    } catch (error) {
        console.error('[RelatrMcpServer] Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server if this file is run directly
if (import.meta.main) {
    main().catch((error) => {
        console.error('[RelatrMcpServer] Fatal error:', error);
        process.exit(1);
    });
}

export { RelatrMcpServer };