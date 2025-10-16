/**
 * Database module exports
 * Provides a unified interface for all database functionality
 */

// Connection management
export {
    DatabaseConnection,
    dbConnection,
    getDatabase,
    initializeDatabase,
    closeDatabase
} from './connection';

// Query execution
export {
    DatabaseHelper,
    db,
    getRawDatabase
} from './query';

// Error handling
export {
    DatabaseError,
    ConnectionError,
    QueryError,
    TransactionError,
    ConstraintError,
    TimeoutError,
    DatabaseErrorHandler,
    DatabaseErrorBoundary,
    errorBoundary
} from './errors';


// Types
export interface DatabaseStats {
    isConnected: boolean;
    path: string;
    pageCount?: number;
    pageSize?: number;
    databaseSize?: number;
}

export interface PubkeyRecord {
    id: number;
    pubkey: string;
    first_seen_at: number;
    last_updated_at: number;
    created_at: number;
    updated_at: number;
}

export interface MetricDefinition {
    id: number;
    metric_name: string;
    metric_type: 'binary' | 'distance' | 'continuous';
    description?: string;
    default_weight: number;
    default_exponent: number;
    is_active: number;
    created_at: number;
    updated_at: number;
}

export interface ProfileMetric {
    id: number;
    pubkey_id: number;
    metric_id: number;
    value: number;
    computed_at: number;
    expires_at?: number;
    metadata?: string;
    created_at: number;
    updated_at: number;
}

export interface TrustScore {
    id: number;
    source_pubkey_id: number;
    target_pubkey_id: number;
    score: number;
    computed_at: number;
    expires_at?: number;
    metric_weights: string;
    metric_values: string;
    formula_version: string;
    created_at: number;
    updated_at: number;
}

export interface Configuration {
    id: number;
    config_key: string;
    config_value: string;
    value_type: 'string' | 'number' | 'boolean' | 'json';
    description?: string;
    created_at: number;
    updated_at: number;
}

export interface NostrEventCache {
    id: number;
    event_id: string;
    pubkey_id: number;
    kind: number;
    content?: string;
    tags?: string;
    created_at_event: number;
    sig: string;
    fetched_at: number;
    expires_at?: number;
}