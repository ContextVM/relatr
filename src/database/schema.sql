-- Enable SQLite optimizations
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Table 1: Profile Metrics Cache
CREATE TABLE IF NOT EXISTS profile_metrics (
    pubkey TEXT PRIMARY KEY,
    metrics TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_metrics_expires ON profile_metrics(expires_at);

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