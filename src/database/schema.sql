-- Enable SQLite optimizations
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Table 1: Profile Metrics Cache
CREATE TABLE IF NOT EXISTS profile_metrics (
    pubkey TEXT PRIMARY KEY,
    nip05_valid REAL NOT NULL DEFAULT 0.0 CHECK(nip05_valid IN (0.0, 1.0)),
    lightning_address REAL NOT NULL DEFAULT 0.0 CHECK(lightning_address IN (0.0, 1.0)),
    event_kind_10002 REAL NOT NULL DEFAULT 0.0 CHECK(event_kind_10002 IN (0.0, 1.0)),
    reciprocity REAL NOT NULL DEFAULT 0.0 CHECK(reciprocity IN (0.0, 1.0)),
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