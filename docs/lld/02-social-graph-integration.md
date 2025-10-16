# Low-Level Design: Social Graph Integration Module

## Overview

This module provides the interface to the `nostr-social-graph` TypeScript library. The social graph is loaded from a pre-computed binary file and provides distance calculations between pubkeys. This module does NOT store graph data in the database - it only uses the in-memory graph provided by `nostr-social-graph`.

## Key Concepts

1. **Pre-computed Graph**: The social graph is loaded from a binary snapshot file (e.g., `data/socialGraph.bin`)
2. **In-Memory Operations**: All graph queries happen in memory via `nostr-social-graph` library
3. **Dynamic Distance Calculation**: Distance between pubkeys is computed on-demand by the library
4. **Root User Switching**: Can change perspective (root pubkey) and recalculate distances efficiently
5. **No DB Storage**: Graph structure and distances are NOT stored in database

## Responsibilities

1. Initialize social graph from pre-computed binary file
2. Provide distance queries between any two pubkeys
3. Support dynamic root user switching for personalized trust perspectives
4. Handle graph persistence (save/load binary snapshots)
5. Optionally update graph with new follow events from Nostr relays
6. Expose query methods for follow relationships

## Module Structure

```
src/social-graph/
├── SocialGraphManager.ts      # Main manager class
├── GraphPersistence.ts        # Binary serialization/deserialization
├── types.ts                   # Type definitions
└── __tests__/
    └── SocialGraphManager.test.ts
```

## Implementation Details

### 1. SocialGraphManager Class

Main orchestrator for social graph operations.

```typescript
import { SocialGraph } from 'nostr-social-graph';
import { GraphPersistence } from './GraphPersistence';
import type { NostrEvent } from './types';

export interface SocialGraphConfig {
    rootPubkey: string;
    graphBinaryPath: string; // Path to pre-computed binary file
    autoSave?: boolean;
    autoSaveInterval?: number; // milliseconds
}

export class SocialGraphManager {
    private graph: SocialGraph | null = null;
    private persistence: GraphPersistence;
    private config: SocialGraphConfig;
    private autoSaveTimer?: Timer;
    private isInitialized: boolean = false;
    
    constructor(config: SocialGraphConfig) {
        this.config = config;
        this.persistence = new GraphPersistence(config.graphBinaryPath);
    }
    
    /**
     * Initialize the social graph from pre-computed binary file
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            console.warn('SocialGraphManager already initialized');
            return;
        }
        
        try {
            // Load pre-computed social graph from binary file
            this.graph = await this.persistence.loadGraph(this.config.rootPubkey);
            
            if (!this.graph) {
                throw new Error('Failed to load social graph from binary file');
            }
            
            const stats = this.graph.size();
            console.log(`Social graph initialized with ${stats.users} users and ${stats.edges} edges`);
            
            this.isInitialized = true;
            
            // Set up auto-save if enabled
            if (this.config.autoSave) {
                this.startAutoSave();
            }
            
        } catch (error) {
            console.error('Failed to initialize social graph:', error);
            throw error;
        }
    }
    
    /**
     * Ensure graph is initialized before operations
     */
    private ensureInitialized(): void {
        if (!this.isInitialized || !this.graph) {
            throw new Error('SocialGraphManager not initialized. Call initialize() first.');
        }
    }
    
    /**
     * Get follow distance from current root to target pubkey
     * Returns integer hop count (1000 if unreachable)
     */
    getFollowDistance(targetPubkey: string): number {
        this.ensureInitialized();
        return this.graph!.getFollowDistance(targetPubkey);
    }
    
    /**
     * Get follow distance between any two pubkeys by temporarily switching root
     * This is more expensive as it requires root switching
     */
    async getDistanceBetween(sourcePubkey: string, targetPubkey: string): Promise<number> {
        this.ensureInitialized();
        
        const currentRoot = this.graph!.getRoot();
        
        // If source is already root, just get distance
        if (currentRoot === sourcePubkey) {
            return this.graph!.getFollowDistance(targetPubkey);
        }
        
        // Otherwise, temporarily switch root
        await this.graph!.setRoot(sourcePubkey);
        const distance = this.graph!.getFollowDistance(targetPubkey);
        
        // Switch back to original root
        await this.graph!.setRoot(currentRoot);
        
        return distance;
    }
    
    /**
     * Check if source follows target
     */
    isFollowing(sourcePubkey: string, targetPubkey: string): boolean {
        this.ensureInitialized();
        return this.graph!.isFollowing(sourcePubkey, targetPubkey);
    }
    
    /**
     * Check if there's mutual follow (reciprocity)
     */
    isReciprocal(pubkey1: string, pubkey2: string): boolean {
        this.ensureInitialized();
        return this.graph!.isFollowing(pubkey1, pubkey2) && 
               this.graph!.isFollowing(pubkey2, pubkey1);
    }
    
    /**
     * Switch the root user and recalculate distances
     * All subsequent distance queries will be from this new root
     */
    async switchRoot(newRootPubkey: string): Promise<void> {
        this.ensureInitialized();
        
        const currentRoot = this.graph!.getRoot();
        if (currentRoot === newRootPubkey) {
            console.log('Root is already set to', newRootPubkey);
            return;
        }
        
        console.log(`Switching root from ${currentRoot} to ${newRootPubkey}`);
        await this.graph!.setRoot(newRootPubkey);
        this.config.rootPubkey = newRootPubkey;
    }
    
    /**
     * Get current root pubkey
     */
    getCurrentRoot(): string {
        this.ensureInitialized();
        return this.graph!.getRoot();
    }
    
    /**
     * Get graph statistics
     */
    getStats(): { users: number; edges: number } {
        this.ensureInitialized();
        return this.graph!.size();
    }
    
    /**
     * Optional: Handle new follow event to update graph
     * This is only needed if you want to update the graph in real-time
     * Most use cases will just use the pre-computed graph
     */
    async handleFollowEvent(event: NostrEvent): Promise<void> {
        this.ensureInitialized();
        
        if (event.kind !== 3) {
            console.warn('Event is not a follow list (kind 3)');
            return;
        }
        
        // Update graph with new event
        this.graph!.handleEvent(event, true);
    }
    
    /**
     * Optional: Handle multiple events in batch
     */
    async handleEventBatch(events: NostrEvent[]): Promise<void> {
        this.ensureInitialized();
        
        const followEvents = events.filter(e => e.kind === 3);
        
        for (const event of followEvents) {
            this.graph!.handleEvent(event, false); // Don't recalculate yet
        }
        
        // Recalculate once after all events
        if (followEvents.length > 0) {
            await this.graph!.recalculateFollowDistances();
        }
    }
    
    /**
     * Persist the current graph state to binary file
     */
    async persist(): Promise<void> {
        this.ensureInitialized();
        await this.persistence.saveGraph(this.graph!, this.config.rootPubkey);
    }
    
    /**
     * Recalculate all follow distances (expensive operation)
     */
    async recalculateDistances(): Promise<void> {
        this.ensureInitialized();
        await this.graph!.recalculateFollowDistances();
    }
    
    /**
     * Get muted pubkeys for a user
     */
    getMutedByUser(pubkey: string): string[] {
        this.ensureInitialized();
        return this.graph!.getMutedByUser(pubkey);
    }
    
    /**
     * Get users who muted a pubkey
     */
    getUserMutedBy(pubkey: string): string[] {
        this.ensureInitialized();
        return this.graph!.getUserMutedBy(pubkey);
    }
    
    /**
     * Clean up resources
     */
    async cleanup(): Promise<void> {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        
        if (this.isInitialized && this.config.autoSave) {
            // Final save before cleanup
            await this.persist();
        }
        
        this.isInitialized = false;
        this.graph = null;
    }
    
    // Private helper methods
    
    private startAutoSave(): void {
        const interval = this.config.autoSaveInterval || 300000; // 5 minutes default
        
        this.autoSaveTimer = setInterval(async () => {
            try {
                await this.persist();
                console.log('Auto-saved social graph');
            } catch (error) {
                console.error('Auto-save failed:', error);
            }
        }, interval);
    }
}
```

---

### 2. GraphPersistence Class

Handles binary serialization and deserialization using `nostr-social-graph` methods.

```typescript
import { SocialGraph } from 'nostr-social-graph';
import { existsSync } from 'node:fs';

export class GraphPersistence {
    private binaryPath: string;
    
    constructor(binaryPath: string) {
        this.binaryPath = binaryPath;
    }
    
    /**
     * Load social graph from binary file
     * The binary file should be a pre-computed snapshot
     */
    async loadGraph(rootPubkey: string): Promise<SocialGraph | null> {
        try {
            const file = Bun.file(this.binaryPath);
            const exists = await file.exists();
            
            if (!exists) {
                console.error(`Binary file not found: ${this.binaryPath}`);
                return null;
            }
            
            console.log(`Loading social graph from ${this.binaryPath}...`);
            const binary = new Uint8Array(await file.arrayBuffer());
            
            // Deserialize using nostr-social-graph's fromBinary method
            const graph = await SocialGraph.fromBinary(rootPubkey, binary);
            
            const stats = graph.size();
            console.log(`Loaded graph with ${stats.users} users and ${stats.edges} edges`);
            
            return graph;
        } catch (error) {
            console.error('Failed to load social graph:', error);
            throw error;
        }
    }
    
    /**
     * Save graph to binary file
     */
    async saveGraph(graph: SocialGraph, rootPubkey: string): Promise<void> {
        try {
            // Serialize graph to binary using nostr-social-graph's toBinary method
            const binary = await graph.toBinary();
            
            // Write to file
            await Bun.write(this.binaryPath, binary);
            
            console.log(`Saved graph to ${this.binaryPath} (${binary.length} bytes)`);
        } catch (error) {
            console.error('Failed to save graph:', error);
            throw error;
        }
    }
    
    /**
     * Save graph with budget parameters for size optimization
     * Useful for creating smaller snapshots
     */
    async saveGraphWithBudget(
        graph: SocialGraph,
        maxNodes?: number,
        maxEdges?: number,
        maxDistance?: number,
        maxEdgesPerNode?: number
    ): Promise<void> {
        try {
            const binary = await graph.toBinary(maxNodes, maxEdges, maxDistance, maxEdgesPerNode);
            await Bun.write(this.binaryPath, binary);
            
            console.log(`Saved optimized graph to ${this.binaryPath} (${binary.length} bytes)`);
        } catch (error) {
            console.error('Failed to save optimized graph:', error);
            throw error;
        }
    }
    
    /**
     * Check if binary file exists
     */
    async exists(): Promise<boolean> {
        const file = Bun.file(this.binaryPath);
        return await file.exists();
    }
}
```

---

### 3. Type Definitions

```typescript
/**
 * Nostr event structure (compatible with both nostr-tools and nostr-social-graph)
 */
export interface NostrEvent {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
}

/**
 * Graph statistics
 */
export interface GraphStats {
    users: number;
    edges: number;
    rootPubkey: string;
}

/**
 * Distance query result
 */
export interface DistanceResult {
    sourcePubkey: string;
    targetPubkey: string;
    distance: number;
    isReachable: boolean;
}
```

---

## Usage Example

```typescript
import { SocialGraphManager } from './social-graph/SocialGraphManager';

// Initialize with pre-computed binary file
const graphManager = new SocialGraphManager({
    rootPubkey: process.env.DEFAULT_SOURCE_PUBKEY!,
    graphBinaryPath: 'data/socialGraph.bin',
    autoSave: false // Usually false since we use pre-computed graph
});

// Load the graph
await graphManager.initialize();

// Query distances
const distance = graphManager.getFollowDistance('target-pubkey-hex...');
console.log(`Distance: ${distance} hops`);

// Check if reachable (distance < 1000)
if (distance < 1000) {
    console.log('Target is reachable!');
} else {
    console.log('Target is not in the social graph');
}

// Check following relationship
const isFollowing = graphManager.isFollowing('source-pubkey...', 'target-pubkey...');
console.log(`Following: ${isFollowing}`);

// Check reciprocal follow
const isReciprocal = graphManager.isReciprocal('pubkey1...', 'pubkey2...');
console.log(`Mutual follow: ${isReciprocal}`);

// Get distance between any two pubkeys (requires root switching)
const customDistance = await graphManager.getDistanceBetween(
    'custom-source...',
    'custom-target...'
);
console.log(`Distance from custom source to target: ${customDistance}`);

// Switch perspective (change root)
await graphManager.switchRoot('new-root-pubkey...');

// Get stats
const stats = graphManager.getStats();
console.log(`Graph: ${stats.users} users, ${stats.edges} edges`);

// Cleanup
await graphManager.cleanup();
```

---

## Integration with Trust Score Calculation

The social graph manager provides the distance metric for trust score computation:

```typescript
import { SocialGraphManager } from './social-graph/SocialGraphManager';
import { TrustScoreCalculator } from './trust/TrustScoreCalculator';

// Initialize graph
const graph = new SocialGraphManager({
    rootPubkey: sourcePubkey,
    graphBinaryPath: 'data/socialGraph.bin'
});
await graph.initialize();

// Get distance (integer hops)
const distance = graph.getFollowDistance(targetPubkey);

// Calculate normalized distance weight
const calculator = new TrustScoreCalculator();
const distanceWeight = calculator.normalizeDistance(distance);

// Use in trust score calculation
const trustScore = calculator.calculateTrustScore({
    distanceWeight,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    // ... other metrics
});
```

---

## Error Handling

```typescript
export class GraphError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'GraphError';
    }
}

export const GraphErrorCodes = {
    NOT_INITIALIZED: 'GRAPH_NOT_INITIALIZED',
    BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
    LOAD_FAILED: 'LOAD_FAILED',
    SAVE_FAILED: 'SAVE_FAILED',
    INVALID_PUBKEY: 'INVALID_PUBKEY',
} as const;

// Usage
try {
    await graphManager.initialize();
} catch (error) {
    if (error instanceof GraphError) {
        console.error(`Graph error [${error.code}]: ${error.message}`);
    }
    throw error;
}
```

---

## Performance Considerations

1. **Pre-computed Graph**: The binary file contains a pre-crawled social graph, eliminating the need to fetch from Nostr relays
2. **In-Memory Operations**: All queries are in-memory, extremely fast (microseconds)
3. **Binary Format**: 55% smaller than JSON, faster to load
4. **Root Switching Cost**: Changing root requires distance recalculation - cache results when possible
5. **Memory Usage**: Large graphs (millions of users) consume significant RAM
6. **No Database Storage**: Graph structure never touches SQLite, keeping DB lightweight

---

## Testing Strategy

```typescript
// Test file: SocialGraphManager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SocialGraphManager } from '../SocialGraphManager';

describe('SocialGraphManager', () => {
    let manager: SocialGraphManager;
    
    beforeEach(async () => {
        manager = new SocialGraphManager({
            rootPubkey: 'test-root-pubkey...',
            graphBinaryPath: 'test-data/test-graph.bin',
            autoSave: false
        });
        await manager.initialize();
    });
    
    afterEach(async () => {
        await manager.cleanup();
    });
    
    it('should initialize from binary file', async () => {
        const stats = manager.getStats();
        expect(stats.users).toBeGreaterThan(0);
        expect(stats.edges).toBeGreaterThan(0);
    });
    
    it('should calculate distance correctly', () => {
        const distance = manager.getFollowDistance('target-pubkey...');
        expect(distance).toBeGreaterThanOrEqual(0);
    });
    
    it('should check following relationships', () => {
        const isFollowing = manager.isFollowing('source...', 'target...');
        expect(typeof isFollowing).toBe('boolean');
    });
    
    it('should switch root and recalculate', async () => {
        const originalRoot = manager.getCurrentRoot();
        await manager.switchRoot('new-root...');
        const newRoot = manager.getCurrentRoot();
        expect(newRoot).not.toBe(originalRoot);
    });
});
```

---

## Pre-computed Binary File

The social graph binary file should be generated separately using the `nostr-social-graph` library:

```typescript
// Script to create pre-computed graph (run separately)
import { SocialGraph } from 'nostr-social-graph';
import { SimplePool } from 'nostr-tools/pool';

const pool = new SimplePool();
const relays = ['wss://relay.damus.io', 'wss://relay.nostr.band'];

// Create graph
const graph = new SocialGraph('root-pubkey');

// Fetch follow events from relays
const events = await pool.querySync(relays, {
    kinds: [3], // Follow lists
    limit: 10000
});

// Process events
for (const event of events) {
    graph.handleEvent(event, false);
}

// Recalculate distances
await graph.recalculateFollowDistances();

// Save to binary
const binary = await graph.toBinary();
await Bun.write('data/socialGraph.bin', binary);

console.log('Pre-computed graph saved!');
```

---

## Future Enhancements

1. **Incremental Updates**: Update pre-computed graph with new events periodically
2. **Multiple Graph Versions**: Keep different graph snapshots for different trust contexts
3. **Graph Partitioning**: Support partial graph loading for very large networks
4. **Distributed Graph**: Federated graph instances across multiple servers
5. **Graph Analytics**: Add centrality measures, clustering coefficients, community detection

---

## Notes

- The social graph is **read-only** in most use cases - we load a pre-computed binary and query it
- **No database storage** for graph structure - everything is in memory via `nostr-social-graph`
- Distance calculations are **on-demand** - we never cache distances in the database
- The binary file should be updated periodically (daily/weekly) by a separate crawler process
- For real-time updates, optionally subscribe to follow events and update the graph
