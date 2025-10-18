import type { MetricWeights, RelatrConfig } from "./types";

/**
 * Load configuration from environment variables
 * @returns Complete RelatrConfig object
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): RelatrConfig {
    const defaultSourcePubkey = process.env.DEFAULT_SOURCE_PUBKEY;
    const graphBinaryPath = process.env.GRAPH_BINARY_PATH;
    const nostrRelays = process.env.NOSTR_RELAYS;
    
    if (!defaultSourcePubkey) {
        throw new Error('DEFAULT_SOURCE_PUBKEY environment variable is required');
    }
    
    if (!graphBinaryPath) {
        throw new Error('GRAPH_BINARY_PATH environment variable is required');
    }
    
    if (!nostrRelays) {
        throw new Error('NOSTR_RELAYS environment variable is required');
    }
    
    return {
        defaultSourcePubkey,
        graphBinaryPath,
        databasePath: process.env.DATABASE_PATH || './data/relatr.db',
        nostrRelays: nostrRelays.split(',').map(relay => relay.trim()),
        decayFactor: parseFloat(process.env.DECAY_FACTOR || '0.1'),
        cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10),
        weights: mergeWeights(getDefaultWeights(), getCustomWeights())
    };
}

/**
 * Get default metric weights
 * @returns Default MetricWeights object
 */
export function getDefaultWeights(): MetricWeights {
    return {
        distanceWeight: 0.5,
        nip05Valid: 0.15,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.15
    };
}

/**
 * Get custom weights from environment variables
 * @returns Partial MetricWeights object with custom values
 */
function getCustomWeights(): Partial<MetricWeights> {
    const customWeights: Partial<MetricWeights> = {};
    
    const distanceWeight = process.env.WEIGHT_DISTANCE;
    if (distanceWeight !== undefined) {
        customWeights.distanceWeight = parseFloat(distanceWeight);
    }
    
    const nip05Valid = process.env.WEIGHT_NIP05;
    if (nip05Valid !== undefined) {
        customWeights.nip05Valid = parseFloat(nip05Valid);
    }
    
    const lightningAddress = process.env.WEIGHT_LIGHTNING;
    if (lightningAddress !== undefined) {
        customWeights.lightningAddress = parseFloat(lightningAddress);
    }
    
    const eventKind10002 = process.env.WEIGHT_EVENT;
    if (eventKind10002 !== undefined) {
        customWeights.eventKind10002 = parseFloat(eventKind10002);
    }
    
    const reciprocity = process.env.WEIGHT_RECIPROCITY;
    if (reciprocity !== undefined) {
        customWeights.reciprocity = parseFloat(reciprocity);
    }
    
    return customWeights;
}

/**
 * Merge default weights with custom weights
 * @param defaults - Default MetricWeights
 * @param custom - Partial MetricWeights to override defaults
 * @returns Merged MetricWeights object
 */
export function mergeWeights(
    defaults: MetricWeights, 
    custom?: Partial<MetricWeights>
): MetricWeights {
    if (!custom) {
        return defaults;
    }
    
    return {
        distanceWeight: custom.distanceWeight ?? defaults.distanceWeight,
        nip05Valid: custom.nip05Valid ?? defaults.nip05Valid,
        lightningAddress: custom.lightningAddress ?? defaults.lightningAddress,
        eventKind10002: custom.eventKind10002 ?? defaults.eventKind10002,
        reciprocity: custom.reciprocity ?? defaults.reciprocity
    };
}

/**
 * Weighting presets for different trust calculation strategies
 */
export const WEIGHTING_PRESETS = {
    default: {
        distanceWeight: 0.5,
        nip05Valid: 0.15,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.15
    },
    conservative: {
        distanceWeight: 0.3,
        nip05Valid: 0.25,
        lightningAddress: 0.15,
        eventKind10002: 0.15,
        reciprocity: 0.15
    },
    progressive: {
        distanceWeight: 0.6,
        nip05Valid: 0.1,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.1
    },
    balanced: {
        distanceWeight: 0.4,
        nip05Valid: 0.2,
        lightningAddress: 0.1,
        eventKind10002: 0.1,
        reciprocity: 0.2
    }
} as const;

/**
 * Get weighting preset by name
 * @param presetName - Name of the preset ('default', 'conservative', 'progressive', 'balanced')
 * @returns MetricWeights for the specified preset
 * @throws Error if preset name is invalid
 */
export function getWeightingPreset(presetName: keyof typeof WEIGHTING_PRESETS): MetricWeights {
    const preset = WEIGHTING_PRESETS[presetName];
    if (!preset) {
        throw new Error(`Invalid weighting preset: ${presetName}. Valid options: ${Object.keys(WEIGHTING_PRESETS).join(', ')}`);
    }
    return preset;
}