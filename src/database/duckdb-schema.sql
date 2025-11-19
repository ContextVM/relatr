-- DuckDB Schema for Relatr
-- Optimized for analytics and full-text search

-- Create sequence for profile_metrics id
CREATE SEQUENCE IF NOT EXISTS seq_profile_metrics_id;

-- Table 1: Profile Metrics Cache (Normalized)
CREATE TABLE IF NOT EXISTS profile_metrics (
    id INTEGER PRIMARY KEY DEFAULT nextval('seq_profile_metrics_id'),
    pubkey VARCHAR NOT NULL,
    metric_key VARCHAR NOT NULL,
    metric_value DOUBLE NOT NULL,
    computed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Indexes for optimized querying
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey ON profile_metrics(pubkey);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_metric_key ON profile_metrics(metric_key);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_computed_at ON profile_metrics(computed_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_expires_at ON profile_metrics(expires_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey_metric ON profile_metrics(pubkey, metric_key);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey_computed ON profile_metrics(pubkey, computed_at);

-- Table 2: Pubkey Metadata with FTS support
CREATE TABLE IF NOT EXISTS pubkey_metadata (
    pubkey VARCHAR PRIMARY KEY,
    name VARCHAR,
    display_name VARCHAR,
    nip05 VARCHAR,
    lud16 VARCHAR,
    about TEXT,
    created_at INTEGER NOT NULL
);

-- Note: FTS index will be created separately using PRAGMA create_fts_index
-- after the tables are populated with data

-- Create FTS index for profile search. Maybe if not exists?
PRAGMA create_fts_index('pubkey_metadata', 'pubkey', 'name', 'display_name', 'nip05', 'about');

-- Table 3: Settings
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL,
    updated_at INTEGER NOT NULL
);