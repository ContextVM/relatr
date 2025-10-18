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

-- Table 2: Pubkey Metadata Cache
CREATE TABLE IF NOT EXISTS pubkey_metadata (
    pubkey TEXT PRIMARY KEY,
    name TEXT,
    display_name TEXT,
    picture TEXT,
    nip05 TEXT,
    lud16 TEXT,
    about TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pubkey_metadata_expires ON pubkey_metadata(expires_at);

-- Table 3: Search Results Cache (pubkeys only)
CREATE TABLE IF NOT EXISTS search_results (
    key TEXT PRIMARY KEY,
    pubkeys TEXT NOT NULL, -- JSON array of pubkeys
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_results_expires ON search_results(expires_at);