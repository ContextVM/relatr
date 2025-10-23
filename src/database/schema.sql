-- Enable SQLite optimizations
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Table 1: Profile Metrics Cache (Normalized)
CREATE TABLE IF NOT EXISTS profile_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value REAL NOT NULL,
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

-- Table 2: Pubkey Metadata FTS5 Virtual Table (uniqueness handled in application layer)
CREATE VIRTUAL TABLE IF NOT EXISTS pubkey_metadata USING fts5(
    pubkey UNINDEXED,
    name,
    display_name,
    nip05,
    lud16,
    about,
    created_at UNINDEXED,
    tokenize='porter unicode61'
);

-- Table 3: Settings
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);