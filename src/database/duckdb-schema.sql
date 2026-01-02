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
    expires_at INTEGER NOT NULL,
    meta TEXT -- Flexible metadata storage (JSON)
);

-- Migration: Add meta column if it doesn't exist (for existing databases)
-- This is safe to run on new databases as well
ALTER TABLE profile_metrics ADD COLUMN IF NOT EXISTS meta TEXT;

-- Indexes for optimized querying
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey ON profile_metrics(pubkey);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_metric_key ON profile_metrics(metric_key);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_computed_at ON profile_metrics(computed_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_expires_at ON profile_metrics(expires_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey_metric ON profile_metrics(pubkey, metric_key);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_pubkey_computed ON profile_metrics(pubkey, computed_at);

-- Table 2: Pubkey Metadata
CREATE TABLE IF NOT EXISTS pubkey_metadata (
    pubkey VARCHAR PRIMARY KEY,
    name VARCHAR,
    display_name VARCHAR,
    nip05 VARCHAR,
    lud16 VARCHAR,
    about TEXT,
    created_at INTEGER NOT NULL
);

-- Table 3: Settings
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Create sequence for ta_subscribers id
CREATE SEQUENCE IF NOT EXISTS seq_ta_subscribers_id;

-- Table 4: Trusted Assertions Subscribers
CREATE TABLE IF NOT EXISTS ta_subscribers (
    id INTEGER PRIMARY KEY DEFAULT nextval('seq_ta_subscribers_id'),
    subscriber_pubkey VARCHAR(64) NOT NULL,
    latest_rank INTEGER, -- Latest computed rank (0-100)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(subscriber_pubkey)
);

-- Indexes for TA subscribers table
CREATE INDEX IF NOT EXISTS idx_ta_subscribers_pubkey
    ON ta_subscribers(subscriber_pubkey);
CREATE INDEX IF NOT EXISTS idx_ta_subscribers_active
    ON ta_subscribers(is_active);
CREATE INDEX IF NOT EXISTS idx_ta_subscribers_created
    ON ta_subscribers(created_at);