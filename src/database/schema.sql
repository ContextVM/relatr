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

-- Table 2: Trust Scores Cache
CREATE TABLE IF NOT EXISTS trust_scores (
    source_pubkey TEXT NOT NULL,
    target_pubkey TEXT NOT NULL,
    score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
    distance_weight REAL NOT NULL,
    nip05_weight REAL NOT NULL,
    lightning_weight REAL NOT NULL,
    event_weight REAL NOT NULL,
    reciprocity_weight REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (source_pubkey, target_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_trust_scores_expires ON trust_scores(expires_at);
CREATE INDEX IF NOT EXISTS idx_trust_scores_source ON trust_scores(source_pubkey);