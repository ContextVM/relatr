import { SocialGraph } from 'nostr-social-graph';
import { GraphError, GraphErrorCodes, type GraphBudget } from './types.js';

/**
 * Handles binary serialization and deserialization using nostr-social-graph methods
 */
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
                throw new GraphError(
                    `Binary file not found: ${this.binaryPath}`,
                    GraphErrorCodes.BINARY_NOT_FOUND
                );
            }
            
            console.log(`Loading social graph from ${this.binaryPath}...`);
            const binary = new Uint8Array(await file.arrayBuffer());
            
            // Validate binary data
            if (binary.length === 0) {
                throw new GraphError(
                    'Binary file is empty',
                    GraphErrorCodes.LOAD_FAILED
                );
            }
            
            // Deserialize using nostr-social-graph's fromBinary method
            const graph = await SocialGraph.fromBinary(rootPubkey, binary);
            
            // Validate graph integrity
            const stats = graph.size();
            if (stats.users === 0) {
                console.warn('Loaded graph has 0 users - this might indicate a corrupted file');
            }
            
            console.log(`Loaded graph with ${stats.users} users and ${stats.follows} follows`);
            
            return graph;
        } catch (error) {
            if (error instanceof GraphError) {
                throw error;
            }
            
            console.error('Failed to load social graph:', error);
            throw new GraphError(
                `Failed to load social graph: ${error instanceof Error ? error.message : 'Unknown error'}`,
                GraphErrorCodes.LOAD_FAILED
            );
        }
    }
    
    /**
     * Save graph to binary file
     */
    async saveGraph(graph: SocialGraph, rootPubkey: string): Promise<void> {
        try {
            // Validate graph
            if (!graph) {
                throw new GraphError(
                    'Cannot save null graph',
                    GraphErrorCodes.SAVE_FAILED
                );
            }
            
            // Serialize graph to binary using nostr-social-graph's toBinary method
            const binary = await graph.toBinary();
            
            // Validate binary data
            if (binary.length === 0) {
                throw new GraphError(
                    'Graph serialization resulted in empty binary data',
                    GraphErrorCodes.SAVE_FAILED
                );
            }
            
            // Write to file
            await Bun.write(this.binaryPath, binary);
            
            console.log(`Saved graph to ${this.binaryPath} (${binary.length} bytes)`);
        } catch (error) {
            if (error instanceof GraphError) {
                throw error;
            }
            
            console.error('Failed to save graph:', error);
            throw new GraphError(
                `Failed to save graph: ${error instanceof Error ? error.message : 'Unknown error'}`,
                GraphErrorCodes.SAVE_FAILED
            );
        }
    }
    
    /**
     * Save graph with budget parameters for size optimization
     * Useful for creating smaller snapshots
     */
    async saveGraphWithBudget(
        graph: SocialGraph,
        rootPubkey: string,
        budget?: GraphBudget
    ): Promise<void> {
        try {
            // Validate graph
            if (!graph) {
                throw new GraphError(
                    'Cannot save null graph',
                    GraphErrorCodes.SAVE_FAILED
                );
            }
            
            // Serialize with budget parameters
            const binary = await graph.toBinary(
                budget?.maxNodes,
                budget?.maxEdges,
                budget?.maxDistance,
                budget?.maxEdgesPerNode
            );
            
            // Validate binary data
            if (binary.length === 0) {
                throw new GraphError(
                    'Graph serialization with budget resulted in empty binary data',
                    GraphErrorCodes.SAVE_FAILED
                );
            }
            
            // Write to file
            await Bun.write(this.binaryPath, binary);
            
            const budgetInfo = budget ? 
                ` with budget (maxNodes: ${budget.maxNodes}, maxEdges: ${budget.maxEdges}, maxDistance: ${budget.maxDistance}, maxEdgesPerNode: ${budget.maxEdgesPerNode})` : 
                '';
            
            console.log(`Saved optimized graph to ${this.binaryPath} (${binary.length} bytes)${budgetInfo}`);
        } catch (error) {
            if (error instanceof GraphError) {
                throw error;
            }
            
            console.error('Failed to save optimized graph:', error);
            throw new GraphError(
                `Failed to save optimized graph: ${error instanceof Error ? error.message : 'Unknown error'}`,
                GraphErrorCodes.SAVE_FAILED
            );
        }
    }
    
    /**
     * Check if binary file exists
     */
    async exists(): Promise<boolean> {
        try {
            const file = Bun.file(this.binaryPath);
            return await file.exists();
        } catch (error) {
            console.error(`Failed to check if binary file exists: ${this.binaryPath}`, error);
            return false;
        }
    }
    
    /**
     * Get file size in bytes
     */
    async getFileSize(): Promise<number> {
        try {
            const file = Bun.file(this.binaryPath);
            return file.size;
        } catch (error) {
            console.error(`Failed to get file size: ${this.binaryPath}`, error);
            return 0;
        }
    }
    
    /**
     * Validate binary file format by attempting to read header
     */
    async validateBinaryFile(): Promise<boolean> {
        try {
            const exists = await this.exists();
            if (!exists) {
                return false;
            }
            
            const file = Bun.file(this.binaryPath);
            const binary = new Uint8Array(await file.arrayBuffer());
            
            // Basic validation - check if file has content
            return binary.length > 0;
        } catch (error) {
            console.error(`Failed to validate binary file: ${this.binaryPath}`, error);
            return false;
        }
    }
}