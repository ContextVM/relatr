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

/**
 * Social graph configuration
 */
export interface SocialGraphConfig {
    rootPubkey: string;
    graphBinaryPath: string; // Path to pre-computed binary file
    autoSave?: boolean;
    autoSaveInterval?: number; // milliseconds
}

/**
 * Graph persistence error codes
 */
export const GraphErrorCodes = {
    NOT_INITIALIZED: 'GRAPH_NOT_INITIALIZED',
    BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
    LOAD_FAILED: 'LOAD_FAILED',
    SAVE_FAILED: 'SAVE_FAILED',
    INVALID_PUBKEY: 'INVALID_PUBKEY',
} as const;

export type GraphErrorCode = typeof GraphErrorCodes[keyof typeof GraphErrorCodes];

/**
 * Custom error class for graph operations
 */
export class GraphError extends Error {
    constructor(message: string, public code: GraphErrorCode) {
        super(message);
        this.name = 'GraphError';
    }
}

/**
 * Budget parameters for optimized graph serialization
 */
export interface GraphBudget {
    maxNodes?: number;
    maxEdges?: number;
    maxDistance?: number;
    maxEdgesPerNode?: number;
}