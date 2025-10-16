-- Relatr Database Schema
-- SQLite schema for caching profile validation metrics and trust scores

-- Enable foreign keys and WAL mode for better performance
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 1. Pubkeys Table
-- Stores all public keys encountered in the system with metadata
CREATE TABLE IF NOT EXISTS pubkeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT UNIQUE NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_updated_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pubkeys_pubkey ON pubkeys(pubkey);
CREATE INDEX IF NOT EXISTS idx_pubkeys_last_updated ON pubkeys(last_updated_at);

-- 2. Metric Definitions Table
-- Stores metadata about available metrics (configuration table)
CREATE TABLE IF NOT EXISTS metric_definitions (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_definitions_name ON metric_definitions(metric_name);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_active ON metric_definitions(is_active);

-- 3. Profile Validation Metrics Table
-- Stores computed profile validation metrics (NIP-05, Lightning Address, etc.)
CREATE TABLE IF NOT EXISTS profile_metrics (
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

CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey ON profile_metrics(pubkey_id);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_metric ON profile_metrics(metric_id);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_expires ON profile_metrics(expires_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_computed ON profile_metrics(computed_at);

-- 4. Trust Scores Table
-- Stores final computed trust scores for pubkey pairs
CREATE TABLE IF NOT EXISTS trust_scores (
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

CREATE INDEX IF NOT EXISTS idx_trust_scores_source ON trust_scores(source_pubkey_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_target ON trust_scores(target_pubkey_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_score ON trust_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_trust_scores_expires ON trust_scores(expires_at);
CREATE INDEX IF NOT EXISTS idx_trust_scores_computed ON trust_scores(computed_at);

-- 5. Configuration Table
-- Stores system configuration parameters
CREATE TABLE IF NOT EXISTS configuration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK(value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_configuration_key ON configuration(config_key);

-- 6. Nostr Events Cache Table
-- Optional table for caching relevant Nostr events to reduce relay queries
CREATE TABLE IF NOT EXISTS nostr_events_cache (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_nostr_events_event_id ON nostr_events_cache(event_id);
CREATE INDEX IF NOT EXISTS idx_nostr_events_pubkey_kind ON nostr_events_cache(pubkey_id, kind);
CREATE INDEX IF NOT EXISTS idx_nostr_events_expires ON nostr_events_cache(expires_at);

-- Insert default metric definitions
INSERT OR IGNORE INTO metric_definitions (metric_name, metric_type, description, default_weight, default_exponent) VALUES
    ('relative_distance', 'distance', 'Social graph distance from source to target', 0.5, 1.0),
    ('nip05_valid', 'binary', 'Valid NIP-05 identifier present', 0.15, 1.0),
    ('lightning_address', 'binary', 'Lightning Network address present', 0.1, 1.0),
    ('event_kind_10002', 'binary', 'Published event kind 10002', 0.1, 1.0),
    ('reciprocity', 'binary', 'Target follows source back', 0.15, 1.0);

-- Insert default configuration
INSERT OR IGNORE INTO configuration (config_key, config_value, value_type, description) VALUES
    ('default_source_pubkey', '', 'string', 'Default source pubkey when none specified'),
    ('distance_decay_factor', '0.1', 'number', 'Alpha parameter for distance decay formula'),
    ('cache_ttl_seconds', '3600', 'number', 'Default cache TTL in seconds'),
    ('max_distance', '1000', 'number', 'Maximum distance value (unreachable marker)'),
    ('formula_version', 'v1', 'string', 'Current trust score formula version');