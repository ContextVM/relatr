# Low-Level Design: MCP Server Interface

## Overview

The MCP (Model Context Protocol) server provides the API interface for Relatr. It exposes tools for computing trust scores and accepts requests specifying target/source pubkeys.

## MCP Tool Definition

### `calculate_trust_score` Tool

Computes the trust score between two pubkeys.

**Input Schema:**
```typescript
{
  targetPubkey: string;      // Required: Pubkey to assess
  sourcePubkey?: string;     // Optional: Perspective (defaults to env var)
  scheme?: string;           // Optional: Weighting scheme (default/conservative/progressive)
  forceRefresh?: boolean;    // Optional: Bypass cache
}
```

**Output Schema:**
```typescript
{
  score: number;                        // Trust score [0,1]
  sourcePubkey: string;                 // Perspective used
  targetPubkey: string;                 // Assessed pubkey
  metrics: {
    distance: number;                   // Social graph distance (hops)
    distanceWeight: number;             // Normalized distance [0,1]
    nip05Valid: number;                 // 0 or 1
    lightningAddress: number;           // 0 or 1
    eventKind10002: number;             // 0 or 1
    reciprocity: number;                // 0 or 1
  };
  computedAt: number;                   // Unix timestamp
  cached: boolean;                      // Was result from cache
}
```

## Implementation

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RelatrService } from '../services/RelatrService';

const server = new McpServer({
    name: 'relatr',
    version: '1.0.0'
});

const relatrService = new RelatrService();
await relatrService.initialize();

server.registerTool(
    'calculate_trust_score',
    {
        title: 'Calculate Trust Score',
        description: 'Compute trust score between two Nostr pubkeys using social graph and profile metrics',
        inputSchema: {
            targetPubkey: z.string().length(64),
            sourcePubkey: z.string().length(64).optional(),
            scheme: z.enum(['default', 'conservative', 'progressive', 'balanced']).optional(),
            forceRefresh: z.boolean().optional(),
        },
        outputSchema: {
            score: z.number().min(0).max(1),
            sourcePubkey: z.string(),
            targetPubkey: z.string(),
            metrics: z.object({
                distance: z.number(),
                distanceWeight: z.number(),
                nip05Valid: z.number(),
                lightningAddress: z.number(),
                eventKind10002: z.number(),
                reciprocity: z.number(),
            }),
            computedAt: z.number(),
            cached: z.boolean(),
        },
    },
    async ({ targetPubkey, sourcePubkey, scheme, forceRefresh }) => {
        const result = await relatrService.calculateTrustScore({
            targetPubkey,
            sourcePubkey: sourcePubkey || process.env.DEFAULT_SOURCE_PUBKEY!,
            scheme: scheme || 'default',
            forceRefresh: forceRefresh || false,
        });
        
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Relatr Service

Orchestrates all modules to compute trust scores.

```typescript
// src/services/RelatrService.ts
import { Database } from 'bun:sqlite';
import { SocialGraphManager } from '../social-graph/SocialGraphManager';
import { DistanceNormalizer } from '../distance/DistanceNormalizer';
import { ProfileMetricsCollector } from '../metrics/ProfileMetricsCollector';
import { TrustScoreCalculator } from '../trust/TrustScoreCalculator';
import { getWeightingScheme } from '../trust/WeightingScheme';

export class RelatrService {
    private db: Database;
    private graphManager: SocialGraphManager;
    private normalizer: DistanceNormalizer;
    private metricsCollector: ProfileMetricsCollector;
    private calculator: TrustScoreCalculator;
    
    constructor() {
        this.db = new Database(process.env.DB_PATH || 'relatr.db');
    }
    
    async initialize(): Promise<void> {
        // Initialize social graph
        this.graphManager = new SocialGraphManager({
            rootPubkey: process.env.DEFAULT_SOURCE_PUBKEY!,
            graphBinaryPath: process.env.GRAPH_BINARY_PATH || 'data/socialGraph.bin',
        });
        await this.graphManager.initialize();
        
        // Initialize normalizer
        this.normalizer = new DistanceNormalizer({
            decayFactor: parseFloat(process.env.DECAY_FACTOR || '0.1'),
        });
        
        // Initialize metrics collector
        this.metricsCollector = new ProfileMetricsCollector(this.db, {
            relays: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io').split(','),
            cacheTtlSeconds: parseInt(process.env.CACHE_TTL || '3600', 10),
            enableNip05: true,
            enableLightning: true,
            enableEventKind10002: true,
            enableReciprocity: true,
        });
        
        // Initialize calculator
        this.calculator = new TrustScoreCalculator({
            cacheResults: true,
            cacheTtlSeconds: parseInt(process.env.CACHE_TTL || '3600', 10),
        }, this.db);
    }
    
    async calculateTrustScore(params: {
        targetPubkey: string;
        sourcePubkey: string;
        scheme: string;
        forceRefresh: boolean;
    }) {
        const { targetPubkey, sourcePubkey, scheme, forceRefresh } = params;
        
        // Switch root if needed
        const currentRoot = this.graphManager.getCurrentRoot();
        if (currentRoot !== sourcePubkey) {
            await this.graphManager.switchRoot(sourcePubkey);
        }
        
        // Get distance
        const distance = this.graphManager.getFollowDistance(targetPubkey);
        const distanceWeight = this.normalizer.normalize(distance);
        
        // Get profile metrics
        if (forceRefresh) {
            await this.metricsCollector.invalidateCache(targetPubkey);
        }
        const metrics = await this.metricsCollector.collectMetrics(targetPubkey, sourcePubkey);
        
        // Calculate trust score
        const weightingScheme = getWeightingScheme(scheme);
        this.calculator.setWeightingScheme(weightingScheme);
        
        const trustScore = await this.calculator.calculate({
            distanceWeight,
            nip05Valid: metrics.nip05Valid,
            lightningAddress: metrics.lightningAddress,
            eventKind10002: metrics.eventKind10002,
            reciprocity: metrics.reciprocity,
        }, sourcePubkey, targetPubkey);
        
        return {
            score: trustScore.score,
            sourcePubkey,
            targetPubkey,
            metrics: {
                distance,
                distanceWeight,
                nip05Valid: metrics.nip05Valid,
                lightningAddress: metrics.lightningAddress,
                eventKind10002: metrics.eventKind10002,
                reciprocity: metrics.reciprocity,
            },
            computedAt: trustScore.computedAt,
            cached: false, // Could check if from cache
        };
    }
    
    async cleanup(): Promise<void> {
        await this.graphManager.cleanup();
        this.metricsCollector.cleanup();
        this.db.close();
    }
}
```

## Environment Variables

```bash
# .env
DEFAULT_SOURCE_PUBKEY=your-default-pubkey-hex
GRAPH_BINARY_PATH=data/socialGraph.bin
DB_PATH=relatr.db
NOSTR_RELAYS=wss://relay.damus.io,wss://relay.nostr.band
DECAY_FACTOR=0.1
CACHE_TTL=3600
```

## Running the Server

```bash
# Install dependencies
bun install

# Run MCP server
bun run src/mcp/server.ts
```

## MCP Client Usage Example

```typescript
// Example client interaction
const result = await client.callTool('calculate_trust_score', {
    targetPubkey: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
    sourcePubkey: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e',
    scheme: 'default'
});

console.log('Trust Score:', result.score);
console.log('Distance:', result.metrics.distance, 'hops');
```

## Error Handling

```typescript
server.registerTool(
    'calculate_trust_score',
    // ... schema ...
    async (params) => {
        try {
            const result = await relatrService.calculateTrustScore(params);
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                structuredContent: result,
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${error.message}`
                }],
                isError: true,
            };
        }
    }
);
```

## Package Configuration

```json
// package.json
{
  "name": "relatr",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "nostr-tools": "^2.0.0",
    "nostr-social-graph": "^1.0.0",
    "zod": "^3.22.0"
  },
  "scripts": {
    "mcp": "bun run src/mcp/server.ts"
  }
}
```

## Summary

The MCP server provides a single tool `calculate_trust_score` that:
1. Accepts target and optional source pubkeys
2. Orchestrates social graph, distance normalization, metrics collection, and score computation
3. Returns comprehensive trust score with metric breakdown
4. Supports caching and multiple weighting schemes
5. Uses stdio transport for MCP communication