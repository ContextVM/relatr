import { SocialGraph } from 'nostr-social-graph';
import { GraphPersistence } from './GraphPersistence.js';
import { 
    type NostrEvent, 
    type SocialGraphConfig, 
    type GraphStats, 
    type DistanceResult,
    GraphError, 
    GraphErrorCodes 
} from './types.js';

/**
 * Main orchestrator for social graph operations
 */
export class SocialGraphManager {
    private graph: SocialGraph | null = null;
    private persistence: GraphPersistence;
    private config: SocialGraphConfig;
    private autoSaveTimer?: ReturnType<typeof setInterval>;
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
                throw new GraphError(
                    'Failed to load social graph from binary file',
                    GraphErrorCodes.LOAD_FAILED
                );
            }
            
            const stats = this.graph.size();
            console.log(`Social graph initialized with ${stats.users} users and ${stats.follows} follows`);
            
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
            throw new GraphError(
                'SocialGraphManager not initialized. Call initialize() first.',
                GraphErrorCodes.NOT_INITIALIZED
            );
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
     * Get distance to root for a target pubkey
     */
    getDistanceToRoot(targetPubkey: string): number {
        this.ensureInitialized();
        return this.graph!.getFollowDistance(targetPubkey);
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
     * Check if pubkey exists in the graph
     */
    isInGraph(pubkey: string): boolean {
        this.ensureInitialized();
        // If distance is 1000 (unreachable), the pubkey is not in the graph
        // But we need to be careful - a pubkey might be in the graph but unreachable
        // For now, we'll check if it's either reachable or has any followers/following
        const distance = this.graph!.getFollowDistance(pubkey);
        if (distance < 1000) return true;
        
        // Additional check: see if this pubkey follows anyone or is followed by anyone
        // This is a more comprehensive check but might be expensive
        // For now, we'll use a simple heuristic
        try {
            // Try to get muted users - if this works, the pubkey exists
            this.graph!.getMutedByUser(pubkey);
            return true;
        } catch {
            return false;
        }
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
    getGraphStatistics(): GraphStats {
        this.ensureInitialized();
        const stats = this.graph!.size();
        return {
            users: stats.users,
            edges: stats.follows, // Map follows to edges for compatibility
            rootPubkey: this.getCurrentRoot()
        };
    }
    
    /**
     * Get graph size (alias for getGraphStatistics for backward compatibility)
     */
    getStats(): { users: number; edges: number } {
        this.ensureInitialized();
        const stats = this.graph!.size();
        return {
            users: stats.users,
            edges: stats.follows
        };
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
        return Array.from(this.graph!.getMutedByUser(pubkey));
    }
    
    /**
     * Get users who muted a pubkey
     */
    getUserMutedBy(pubkey: string): string[] {
        this.ensureInitialized();
        return Array.from(this.graph!.getUserMutedBy(pubkey));
    }
    
    /**
     * Get distance result with additional metadata
     */
    async getDistanceResult(sourcePubkey: string, targetPubkey: string): Promise<DistanceResult> {
        const distance = await this.getDistanceBetween(sourcePubkey, targetPubkey);
        return {
            sourcePubkey,
            targetPubkey,
            distance,
            isReachable: distance < 1000
        };
    }
    
    /**
     * Check if manager is initialized
     */
    isManagerInitialized(): boolean {
        return this.isInitialized;
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
            try {
                await this.persist();
            } catch (error) {
                console.error('Failed to save graph during cleanup:', error);
            }
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