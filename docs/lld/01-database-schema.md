# Low-Level Design: Database Schema

## Overview

This document defines the SQLite database schema for Relatr. The schema is designed to cache profile validation metrics and trust scores. The social graph itself is handled by the `nostr-social-graph` library using pre-computed binary files, so we don't store graph data or distances in the database.

## Design Principles

1. **Normalization**: Properly normalized to 3NF to avoid data redundancy
2. **Performance**: Indexed for fast lookups on common query patterns
3. **Extensibility**: Easy to add new metrics without schema changes
4. **Separation of Concerns**: Profile validation metrics vs. trust scores
5. **Dynamic Distance**: Social graph distances are computed on-demand by `nostr-social-graph`, NOT stored in DB
6. **Cache-Only**: Only stores computed validation results and final trust scores for performance

## Schema Definition

### 1. Pubkeys Table

Stores all public keys encountered in the system with metadata.

```sql
CREATE TABLE pubkeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT UNIQUE NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_updated_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_pubkeys_pubkey ON pubkeys(pubkey);
CREATE INDEX idx_pubkeys_last_updated ON pubkeys(last_updated_at);
```

**Fields:**
- `id`: Internal surrogate key for foreign key relationships
- `pubkey`: Hex-encoded public key (64 chars)
- `first_seen_at`: Unix timestamp when first encountered
- `last_updated_at`: Unix timestamp when any metric was last updated
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

---

### 2. Metric Definitions Table

Stores metadata about available metrics (configuration table).

```sql
CREATE TABLE metric_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT UNIQUE NOT NULL,
    metric_type TEXT NOT NULL CHECK(metric_type IN ('binary', 'distance', 'continuous')),
    description TEXT,
    default_weight REAL NOT NULL DEFAULT 0.0,
    default_exponent REAL NOT NULL DEFAULT 1.0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_metric_definitions_name ON metric_definitions(metric_name);
CREATE INDEX idx_metric_definitions_active ON metric_definitions(is_active);

-- Insert default metrics
INSERT INTO metric_definitions (metric_name, metric_type, description, default_weight, default_exponent) VALUES
    ('relative_distance', 'distance', 'Social graph distance from source to target', 0.5, 1.0),
    ('nip05_valid', 'binary', 'Valid NIP-05 identifier present', 0.15, 1.0),
    ('lightning_address', 'binary', 'Lightning Network address present', 0.1, 1.0),
    ('event_kind_10002', 'binary', 'Published event kind 10002', 0.1, 1.0),
    ('reciprocity', 'binary', 'Target follows source back', 0.15, 1.0);
```

**Fields:**
- `metric_name`: Unique identifier for the metric
- `metric_type`: Type of metric (binary: 0/1, distance: graph hops, continuous: 0-1 range)
- `description`: Human-readable description
- `default_weight`: Default weight in trust score calculation
- `default_exponent`: Default exponent (p_i in the formula)
- `is_active`: Whether this metric is currently being computed

---

### 3. Profile Validation Metrics Table

Stores computed profile validation metrics (NIP-05, Lightning Address, etc.).

```sql
CREATE TABLE profile_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey_id INTEGER NOT NULL,
    metric_id INTEGER NOT NULL,
    value REAL NOT NULL CHECK(value IN (0.0, 1.0)),
    computed_at INTEGER NOT NULL,
    expires_at INTEGER,
    metadata TEXT, -- JSON for additional context (e.g., NIP-05 domain, LN address)
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (pubkey_id) REFERENCES pubkeys(id) ON DELETE CASCADE,
    FOREIGN KEY (metric_id) REFERENCES metric_definitions(id) ON DELETE CASCADE,
    UNIQUE(pubkey_id, metric_id)
);

CREATE INDEX idx_profile_metrics_pubkey ON profile_metrics(pubkey_id);
CREATE INDEX idx_profile_metrics_metric ON profile_metrics(metric_id);
CREATE INDEX idx_profile_metrics_expires ON profile_metrics(expires_at);
CREATE INDEX idx_profile_metrics_computed ON profile_metrics(computed_at);
```

**Fields:**
- `pubkey_id`: Foreign key to pubkeys table
- `metric_id`: Foreign key to metric_definitions table
- `value`: Normalized value (0.0 or 1.0)
- `computed_at`: Unix timestamp when metric was computed
- `expires_at`: Optional expiration timestamp for cache invalidation
- `metadata`: JSON field for storing validation details (e.g., NIP-05 domain, LN address, verification timestamp)

**Note**: Distance metrics are NOT stored here - they are computed on-demand by `nostr-social-graph`.

---

### 4. Trust Scores Table

Stores final computed trust scores for pubkey pairs.

```sql
CREATE TABLE trust_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_pubkey_id INTEGER NOT NULL,
    target_pubkey_id INTEGER NOT NULL,
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    computed_at INTEGER NOT NULL,
    expires_at INTEGER,
    metric_weights TEXT NOT NULL, -- JSON: {metric_name: weight}
    metric_values TEXT NOT NULL, -- JSON: {metric_name: value}
    formula_version TEXT NOT NULL DEFAULT 'v1',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (source_pubkey_id) REFERENCES pubkeys(id) ON DELETE CASCADE,
    FOREIGN KEY (target_pubkey_id) REFERENCES pubkeys(id) ON DELETE CASCADE,
    UNIQUE(source_pubkey_id, target_pubkey_id, formula_version)
);

CREATE INDEX idx_trust_scores_source ON trust_scores(source_pubkey_id);
CREATE INDEX idx_trust_scores_target ON trust_scores(target_pubkey_id);
CREATE INDEX idx_trust_scores_score ON trust_scores(score DESC);
CREATE INDEX idx_trust_scores_expires ON trust_scores(expires_at);
CREATE INDEX idx_trust_scores_computed ON trust_scores(computed_at);
```

**Fields:**
- `source_pubkey_id`: Perspective pubkey (who is assessing trust)
- `target_pubkey_id`: Subject pubkey (who is being assessed)
- `score`: Final computed trust score (0-1)
- `computed_at`: When score was calculated
- `expires_at`: Cache expiration
- `metric_weights`: JSON snapshot of weights used in calculation
- `metric_values`: JSON snapshot of metric values used
- `formula_version`: Version identifier for formula changes

---

### 5. Configuration Table

Stores system configuration parameters.

```sql
CREATE TABLE configuration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK(value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_configuration_key ON configuration(config_key);

-- Insert default configuration
INSERT INTO configuration (config_key, config_value, value_type, description) VALUES
    ('default_source_pubkey', '', 'string', 'Default source pubkey when none specified'),
    ('distance_decay_factor', '0.1', 'number', 'Alpha parameter for distance decay formula'),
    ('cache_ttl_seconds', '3600', 'number', 'Default cache TTL in seconds'),
    ('max_distance', '1000', 'number', 'Maximum distance value (unreachable marker)'),
    ('formula_version', 'v1', 'string', 'Current trust score formula version');
```

---

### 6. Nostr Events Cache Table

Optional table for caching relevant Nostr events to reduce relay queries.

```sql
CREATE TABLE nostr_events_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    pubkey_id INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    content TEXT,
    tags TEXT, -- JSON array of tags
    created_at_event INTEGER NOT NULL,
    sig TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER,
    FOREIGN KEY (pubkey_id) REFERENCES pubkeys(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_nostr_events_event_id ON nostr_events_cache(event_id);
CREATE INDEX idx_nostr_events_pubkey_kind ON nostr_events_cache(pubkey_id, kind);
CREATE INDEX idx_nostr_events_expires ON nostr_events_cache(expires_at);
```

**Fields:**
- `event_id`: Nostr event ID (hex)
- `pubkey_id`: Foreign key to pubkeys
- `kind`: Nostr event kind
- `content`: Event content
- `tags`: JSON array of event tags
- `created_at_event`: Timestamp from the event itself
- `sig`: Event signature
- `fetched_at`: When we cached this event
- `expires_at`: Cache expiration

---

## Database Initialization Script

```typescript
import { Database } from "bun:sqlite";

export function initializeDatabase(dbPath: string): Database {
    const db = new Database(dbPath, { create: true });
    
    // Enable WAL mode for better performance
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA synchronous = NORMAL;");
    
    // Create all tables (execute schema from above)
    // ... (full schema creation)
    
    return db;
}
```

---

## Query Patterns

### 1. Get Trust Score for Pubkey Pair

```typescript
interface GetTrustScoreParams {
    sourcePubkey: string;
    targetPubkey: string;
}

const query = db.query(`
    SELECT ts.score, ts.computed_at, ts.metric_weights, ts.metric_values
    FROM trust_scores ts
    JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
    JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
    WHERE sp.pubkey = $sourcePubkey
      AND tp.pubkey = $targetPubkey
      AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
    ORDER BY ts.computed_at DESC
    LIMIT 1
`);
```

### 2. Get All Metrics for a Pubkey

```typescript
const query = db.query(`
    SELECT md.metric_name, bm.value, bm.computed_at
    FROM binary_metrics bm
    JOIN metric_definitions md ON bm.metric_id = md.id
    JOIN pubkeys p ON bm.pubkey_id = p.id
    WHERE p.pubkey = $pubkey
      AND (bm.expires_at IS NULL OR bm.expires_at > unixepoch())
      AND md.is_active = 1
`);
```

### 3. Invalidate Expired Cache Entries

```typescript
const cleanupQuery = db.query(`
    DELETE FROM trust_scores
    WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
`);
```

---

## Cache Invalidation Strategy

1. **Time-based**: Use `expires_at` field with configurable TTL
2. **Event-based**: Invalidate on new Nostr events (kind 3 for follows, kind 0 for profile updates)
3. **Manual**: API endpoint to force refresh specific pubkeys

---

## Migration Strategy

For schema changes, use versioned migration files:

```typescript
// migrations/001_initial_schema.ts
export function up(db: Database) {
    // Create tables
}

export function down(db: Database) {
    // Rollback
}
```

---

## Performance Considerations

1. **Indexes**: All foreign keys and frequently queried columns are indexed
2. **WAL Mode**: Enabled for concurrent read/write performance
3. **Prepared Statements**: All queries should use prepared statements
4. **Batch Operations**: Use transactions for bulk inserts/updates
5. **Vacuum**: Periodic VACUUM to reclaim space and optimize

---

## Backup and Maintenance

```typescript
// Daily backup
db.exec("VACUUM INTO 'backup.db'");

// Cleanup old entries
db.exec("DELETE FROM trust_scores WHERE computed_at < unixepoch() - 86400 * 30");
```

---

## Future Extensions

Potential schema additions:
- `metric_history` table for tracking metric changes over time
- `computation_logs` table for debugging and analytics
- `relay_metadata` table for tracking which relays provided data
- `pubkey_labels` table for user-defined labels/categories
