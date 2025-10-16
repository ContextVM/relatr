import { z } from 'zod';

const envSchema = z.object({
    DEFAULT_SOURCE_PUBKEY: z.string().length(64),
    GRAPH_BINARY_PATH: z.string().default('data/socialGraph.bin'),
    DB_PATH: z.string().default('data/relatr.db'),
    NOSTR_RELAYS: z.string().transform(s => s.split(',')),
    DECAY_FACTOR: z.string().transform(Number).default('0.1'),
    MAX_DISTANCE: z.string().transform(Number).default('1000'),
    CACHE_TTL: z.string().transform(Number).default('3600'),
    PROFILE_METRICS_TTL: z.string().transform(Number).default('3600'),
    TRUST_SCORES_TTL: z.string().transform(Number).default('3600'),
    WEIGHTING_SCHEME: z.enum(['default', 'conservative', 'progressive', 'balanced']).default('default'),
    AUTO_SAVE_INTERVAL: z.string().transform(Number).default('300000'),
    ENABLE_AUTO_SAVE: z.string().transform(s => s === 'true').default('false'),
    ENABLE_NIP05: z.string().transform(s => s === 'true').default('true'),
    ENABLE_LIGHTNING: z.string().transform(s => s === 'true').default('true'),
    ENABLE_EVENT_KIND_10002: z.string().transform(s => s === 'true').default('true'),
    ENABLE_RECIPROCITY: z.string().transform(s => s === 'true').default('true'),
});

export type EnvironmentConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvironmentConfig {
    const result = envSchema.safeParse(process.env);
    
    if (!result.success) {
        console.error('Invalid environment configuration:');
        console.error(result.error.format());
        throw new Error('Configuration validation failed');
    }
    
    return result.data;
}

// Startup validation
function validateConfig(cfg: EnvironmentConfig): void {
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
    
    if (cfg.MAX_DISTANCE <= 0) {
        throw new Error('MAX_DISTANCE must be positive');
    }
    
    if (cfg.AUTO_SAVE_INTERVAL <= 0) {
        throw new Error('AUTO_SAVE_INTERVAL must be positive');
    }
}

// Export singleton
export const config = loadConfig();

// Validate configuration on load
validateConfig(config);

// Demo script - when run directly, output success message
if (import.meta.main) {
    console.log('Configuration loaded successfully');
    console.log('Default source pubkey:', config.DEFAULT_SOURCE_PUBKEY);
    console.log('Graph binary path:', config.GRAPH_BINARY_PATH);
    console.log('Database path:', config.DB_PATH);
    console.log('Nostr relays:', config.NOSTR_RELAYS);
    console.log('Decay factor:', config.DECAY_FACTOR);
    console.log('Cache TTL:', config.CACHE_TTL);
}

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