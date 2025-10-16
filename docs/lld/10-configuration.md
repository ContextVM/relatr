# Low-Level Design: Configuration Management

## Overview

Configuration is managed through environment variables with sensible defaults. All settings are loaded at startup and validated.

## Environment Variables

```bash
# .env

# === Core Settings ===
DEFAULT_SOURCE_PUBKEY=<hex-pubkey>      # Required: Default perspective
GRAPH_BINARY_PATH=data/socialGraph.bin  # Social graph file location
DB_PATH=data/relatr.db                  # SQLite database path

# === Nostr Settings ===
NOSTR_RELAYS=wss://relay.damus.io,wss://relay.nostr.band
# Comma-separated relay URLs

# === Distance Normalization ===
DECAY_FACTOR=0.1                        # Alpha in distance formula
MAX_DISTANCE=1000                       # Unreachable threshold

# === Caching ===
CACHE_TTL=3600                          # Cache TTL in seconds (1 hour)
PROFILE_METRICS_TTL=3600                # Profile metrics TTL
TRUST_SCORES_TTL=3600                   # Trust scores TTL

# === Weighting Scheme ===
WEIGHTING_SCHEME=default                # default|conservative|progressive|balanced

# === Performance ===
AUTO_SAVE_INTERVAL=300000               # Graph auto-save (5 min, in ms)
ENABLE_AUTO_SAVE=false                  # Auto-save social graph changes

# === Features ===
ENABLE_NIP05=true                       # Enable NIP-05 validation
ENABLE_LIGHTNING=true                   # Enable Lightning address check
ENABLE_EVENT_KIND_10002=true            # Enable relay list check
ENABLE_RECIPROCITY=true                 # Enable mutual follow check
```

## Configuration Loader

```typescript
// src/config/environment.ts
import { z } from 'zod';

const envSchema = z.object({
    DEFAULT_SOURCE_PUBKEY: z.string().length(64),
    GRAPH_BINARY_PATH: z.string().default('data/socialGraph.bin'),
    DB_PATH: z.string().default('data/relatr.db'),
    NOSTR_RELAYS: z.string().transform(s => s.split(',')),
    DECAY_FACTOR: z.string().transform(Number).default('0.1'),
    MAX_DISTANCE: z.string().transform(Number).default('1000'),
    CACHE_TTL: z.string().transform(Number).default('3600'),
    WEIGHTING_SCHEME: z.enum(['default', 'conservative', 'progressive', 'balanced']).default('default'),
    AUTO_SAVE_INTERVAL: z.string().transform(Number).default('300000'),
    ENABLE_AUTO_SAVE: z.string().transform(s => s === 'true').default('false'),
    ENABLE_NIP05: z.string().transform(s => s === 'true').default('true'),
    ENABLE_LIGHTNING: z.string().transform(s => s === 'true').default('true'),
    ENABLE_EVENT_KIND_10002: z.string().transform(s => s === 'true').default('true'),
    ENABLE_RECIPROCITY: z.string().transform(s => s === 'true').default('true'),
});

export type EnvironmentConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvironmentConfig {
    const result = envSchema.safeParse(process.env);
    
    if (!result.success) {
        console.error('Invalid environment configuration:');
        console.error(result.error.format());
        throw new Error('Configuration validation failed');
    }
    
    return result.data;
}

// Export singleton
export const config = loadConfig();
```

## Usage in Modules

```typescript
// Example: Using config in RelatrService
import { config } from '@/config/environment';

class RelatrService {
    async initialize() {
        this.graphManager = new SocialGraphManager({
            rootPubkey: config.DEFAULT_SOURCE_PUBKEY,
            graphBinaryPath: config.GRAPH_BINARY_PATH,
            autoSave: config.ENABLE_AUTO_SAVE,
            autoSaveInterval: config.AUTO_SAVE_INTERVAL,
        });
        
        this.normalizer = new DistanceNormalizer({
            decayFactor: config.DECAY_FACTOR,
            maxDistance: config.MAX_DISTANCE,
        });
        
        this.metricsCollector = new ProfileMetricsCollector(db, {
            relays: config.NOSTR_RELAYS,
            cacheTtlSeconds: config.CACHE_TTL,
            enableNip05: config.ENABLE_NIP05,
            enableLightning: config.ENABLE_LIGHTNING,
            enableEventKind10002: config.ENABLE_EVENT_KIND_10002,
            enableReciprocity: config.ENABLE_RECIPROCITY,
        });
    }
}
```

## Runtime Configuration (Database)

For settings that can change without restart:

```typescript
// Load from database configuration table
class ConfigManager {
    async getDecayFactor(): Promise<number> {
        const row = db.query(`
            SELECT config_value FROM configuration 
            WHERE config_key = 'distance_decay_factor'
        `).get() as any;
        
        return row ? parseFloat(row.config_value) : config.DECAY_FACTOR;
    }
    
    async updateDecayFactor(value: number): Promise<void> {
        db.query(`
            UPDATE configuration 
            SET config_value = $value, updated_at = unixepoch()
            WHERE config_key = 'distance_decay_factor'
        `).run({ $value: value.toString() });
    }
}
```

## Validation

```typescript
// Startup validation
export function validateConfig(cfg: EnvironmentConfig): void {
    // Validate pubkey format
    if (!/^[0-9a-f]{64}$/i.test(cfg.DEFAULT_SOURCE_PUBKEY)) {
        throw new Error('Invalid DEFAULT_SOURCE_PUBKEY format');
    }
    
    // Validate relays
    for (const relay of cfg.NOSTR_RELAYS) {
        if (!relay.startsWith('wss://') && !relay.startsWith('ws://')) {
            throw new Error(`Invalid relay URL: ${relay}`);
        }
    }
    
    // Validate numeric ranges
    if (cfg.DECAY_FACTOR <= 0 || cfg.DECAY_FACTOR > 1) {
        throw new Error('DECAY_FACTOR must be in (0, 1]');
    }
    
    if (cfg.CACHE_TTL < 0) {
        throw new Error('CACHE_TTL must be non-negative');
    }
}

validateConfig(config);
```

## Configuration Profiles

```typescript
// Development
export const devConfig = {
    NOSTR_RELAYS: ['wss://relay.damus.io'],
    CACHE_TTL: 60, // 1 minute for testing
    ENABLE_AUTO_SAVE: false,
};

// Production
export const prodConfig = {
    NOSTR_RELAYS: ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol'],
    CACHE_TTL: 3600,
    ENABLE_AUTO_SAVE: true,
};
```

## Summary

**Configuration Sources:**
1. **Environment Variables** (primary) - `.env` file
2. **Database** (runtime) - `configuration` table
3. **Defaults** (fallback) - Hard-coded in schema

**Key Principles:**
- ✅ Type-safe with Zod validation
- ✅ Fail-fast on invalid config
- ✅ Clear defaults for all settings
- ✅ Centralized configuration loading
- ✅ Runtime updates via database