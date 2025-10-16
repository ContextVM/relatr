import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from "bun:sqlite";
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Import database modules
import { 
    DatabaseConnection,
    DatabaseHelper,
} from '../index';

// Test database path
const testDbPath = join(tmpdir(), `relatr-test-${randomUUID()}.db`);

describe('Database Connection', () => {
    let connection: DatabaseConnection;

    beforeEach(() => {
        connection = DatabaseConnection.getInstance();
    });

    afterEach(() => {
        if (connection.isConnectedToDatabase()) {
            connection.close();
        }
    });

    it('should create and connect to database', () => {
        const db = connection.connect();
        expect(db).toBeDefined();
        expect(connection.isConnectedToDatabase()).toBe(true);
    });

    it('should perform health check', () => {
        connection.connect();
        expect(connection.healthCheck()).toBe(true);
    });

    it('should get database statistics', () => {
        connection.connect();
        const stats = connection.getStats();
        expect(stats.isConnected).toBe(true);
        expect(stats.path).toBeDefined();
    });

    it('should close database connection', () => {
        connection.connect();
        connection.close();
        expect(connection.isConnectedToDatabase()).toBe(false);
    });
});

describe('Database Helper', () => {
    let dbHelper: DatabaseHelper;
    let rawDb: Database;

    beforeEach(() => {
        rawDb = new Database(testDbPath, { create: true });
        
        // Set up test schema
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS pubkeys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pubkey TEXT UNIQUE NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_updated_at INTEGER NOT NULL,
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch())
            );
            
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
            
            CREATE TABLE IF NOT EXISTS trust_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_pubkey_id INTEGER NOT NULL,
                target_pubkey_id INTEGER NOT NULL,
                score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
                computed_at INTEGER NOT NULL,
                expires_at INTEGER,
                metric_weights TEXT NOT NULL,
                metric_values TEXT NOT NULL,
                formula_version TEXT NOT NULL DEFAULT 'v1',
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch())
            );
        `);
        
        // Insert test metric definition
        rawDb.exec(`
            INSERT OR IGNORE INTO metric_definitions (metric_name, metric_type, description, default_weight, default_exponent)
            VALUES ('test_metric', 'binary', 'Test metric', 0.5, 1.0);
        `);
        
        dbHelper = new DatabaseHelper(rawDb);
    });

    afterEach(() => {
        rawDb.close();
    });

    it('should get or create pubkey', () => {
        const testPubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        
        // First call should create
        const id1 = dbHelper.getOrCreatePubkey(testPubkey);
        expect(id1).toBeDefined();
        expect(id1).toBeGreaterThan(0);
        
        // Second call should return existing
        const id2 = dbHelper.getOrCreatePubkey(testPubkey);
        expect(id2).toBe(id1);
    });

    it('should insert trust score', () => {
        const sourcePubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const targetPubkey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
        
        // Create pubkeys
        const sourceId = dbHelper.getOrCreatePubkey(sourcePubkey);
        const targetId = dbHelper.getOrCreatePubkey(targetPubkey);
        
        // Insert trust score
        const trustId = dbHelper.insertTrustScore({
            sourcePubkeyId: sourceId,
            targetPubkeyId: targetId,
            score: 0.85,
            metricWeights: '{"test_metric": 0.5}',
            metricValues: '{"test_metric": 1.0}'
        });
        
        expect(trustId).toBeDefined();
        expect(trustId).toBeGreaterThan(0);
        
        // Get trust score
        const trustScore = dbHelper.getTrustScore(sourceId, targetId);
        expect(trustScore).toBeDefined();
        expect(trustScore?.score).toBe(0.85);
    });

    it('should count records', () => {
        const testPubkey = randomUUID().replace(/-/g, '').substring(0, 64);
        
        const initialCount = dbHelper.count('pubkeys');
        
        dbHelper.getOrCreatePubkey(testPubkey);
        expect(dbHelper.count('pubkeys')).toBe(initialCount + 1);
    });

    it('should check if record exists', () => {
        const testPubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        
        // Check if pubkey exists before creating
        const existsBefore = dbHelper.count('pubkeys', 'pubkey = $pubkey', { $pubkey: testPubkey }) > 0;
        
        dbHelper.getOrCreatePubkey(testPubkey);
        const existsAfter = dbHelper.count('pubkeys', 'pubkey = $pubkey', { $pubkey: testPubkey }) > 0;
        
        expect(existsAfter).toBe(true);
    });

    it('should get and set configuration', () => {
        // Set up configuration table
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS configuration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                config_key TEXT UNIQUE NOT NULL,
                config_value TEXT NOT NULL,
                value_type TEXT NOT NULL CHECK(value_type IN ('string', 'number', 'boolean', 'json')),
                description TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch())
            );
        `);
        
        // Set config
        dbHelper.setConfig('test_key', 'test_value', 'string');
        
        // Get config
        const value = dbHelper.getConfig('test_key');
        expect(value).toBe('test_value');
        
        // Get non-existent config
        const nonExistent = dbHelper.getConfig('non_existent');
        expect(nonExistent).toBeUndefined();
    });

    it('should cleanup expired entries', () => {
        // Set up profile_metrics table
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS profile_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pubkey_id INTEGER NOT NULL,
                metric_id INTEGER NOT NULL,
                value REAL NOT NULL CHECK(value IN (0.0, 1.0)),
                computed_at INTEGER NOT NULL,
                expires_at INTEGER,
                metadata TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch())
            );
            
            CREATE TABLE IF NOT EXISTS nostr_events_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT UNIQUE NOT NULL,
                pubkey_id INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                content TEXT,
                tags TEXT,
                created_at_event INTEGER NOT NULL,
                sig TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                expires_at INTEGER
            );
        `);
        
        const testPubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const pubkeyId = dbHelper.getOrCreatePubkey(testPubkey);
        
        // Get metric ID
        const metric = rawDb.query(
            "SELECT id FROM metric_definitions WHERE metric_name = $metric_name"
        ).get({ $metric_name: 'test_metric' }) as { id: number };
        
        // Insert expired metric
        const expiredTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
        rawDb.query(`
            INSERT INTO profile_metrics (pubkey_id, metric_id, value, computed_at, expires_at)
            VALUES ($pubkey_id, $metric_id, $value, $computed_at, $expires_at)
        `).run({
            $pubkey_id: pubkeyId,
            $metric_id: metric.id,
            $value: 1.0,
            $computed_at: expiredTime,
            $expires_at: expiredTime + 1800 // Expired 30 minutes ago
        });
        
        // Verify expired entry exists
        expect(dbHelper.count('profile_metrics')).toBe(1);
        
        // Cleanup expired entries
        dbHelper.cleanupExpired();
        
        // Verify expired entry was removed
        expect(dbHelper.count('profile_metrics')).toBe(0);
    });
});

describe('Error Handling', () => {
    it('should handle database errors gracefully', () => {
        const rawDb = new Database(testDbPath, { create: true });
        const dbHelper = new DatabaseHelper(rawDb);
        
        // Try to query non-existent table
        expect(() => {
            rawDb.query("SELECT * FROM nonexistent_table").all();
        }).toThrow();
        
        rawDb.close();
    });
});