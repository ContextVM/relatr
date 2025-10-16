import type { DistanceNormalizerConfig, DecayProfileMetadata } from './types';

/**
 * Pre-defined decay profiles for common use cases
 */
export const DecayProfiles = {
    /**
     * Default profile (α = 0.1)
     * Weight drops 10% per hop
     * Zero at ~11 hops
     */
    DEFAULT: {
        decayFactor: 0.1,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Conservative profile (α = 0.2)
     * Faster decay, more selective trust
     * Weight drops 20% per hop
     * Zero at ~6 hops
     */
    CONSERVATIVE: {
        decayFactor: 0.2,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Progressive profile (α = 0.05)
     * Slower decay, broader trust network
     * Weight drops 5% per hop
     * Zero at ~21 hops
     */
    PROGRESSIVE: {
        decayFactor: 0.05,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Balanced profile (α = 0.15)
     * Moderate decay, balanced approach
     * Weight drops 15% per hop
     * Zero at ~8 hops
     */
    BALANCED: {
        decayFactor: 0.15,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Strict profile (α = 0.3)
     * Very fast decay, highly localized trust
     * Weight drops 30% per hop
     * Zero at ~4 hops
     */
    STRICT: {
        decayFactor: 0.3,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Extended profile (α = 0.025)
     * Very slow decay, network-wide trust
     * Weight drops 2.5% per hop
     * Zero at ~41 hops
     */
    EXTENDED: {
        decayFactor: 0.025,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
} as const;

/**
 * Type for decay profile names
 */
export type DecayProfileName = keyof typeof DecayProfiles;

/**
 * Get a decay profile by name
 */
export function getDecayProfile(
    name: DecayProfileName
): DistanceNormalizerConfig {
    return { ...DecayProfiles[name] };
}

/**
 * Get all available decay profiles
 */
export function getAllDecayProfiles(): Record<DecayProfileName, DistanceNormalizerConfig> {
    const profiles: Record<DecayProfileName, DistanceNormalizerConfig> = {} as any;
    
    for (const name in DecayProfiles) {
        profiles[name as DecayProfileName] = { ...DecayProfiles[name as DecayProfileName] };
    }
    
    return profiles;
}

/**
 * Create a custom profile with validation
 */
export function createCustomProfile(
    decayFactor: number,
    options?: {
        maxDistance?: number;
        selfWeight?: number;
    }
): DistanceNormalizerConfig {
    return {
        decayFactor,
        maxDistance: options?.maxDistance ?? 1000,
        selfWeight: options?.selfWeight ?? 1.0,
    };
}

/**
 * Validate a decay profile
 */
export function validateDecayProfile(config: DistanceNormalizerConfig): string[] {
    const errors: string[] = [];
    
    if (config.decayFactor <= 0) {
        errors.push(`decayFactor must be positive, got ${config.decayFactor}`);
    }
    
    if (config.decayFactor > 1) {
        errors.push(`decayFactor ${config.decayFactor} > 1 may produce negative weights`);
    }
    
    if (config.maxDistance <= 0) {
        errors.push(`maxDistance must be positive, got ${config.maxDistance}`);
    }
    
    if (config.selfWeight < 0 || config.selfWeight > 1) {
        errors.push(`selfWeight must be in [0,1], got ${config.selfWeight}`);
    }
    
    return errors;
}

/**
 * Get metadata for a decay profile
 */
export function getDecayProfileMetadata(name: DecayProfileName): DecayProfileMetadata {
    const config = DecayProfiles[name];
    const zeroWeightThreshold = Math.ceil(1 + (1 / config.decayFactor));
    
    const characteristics: string[] = [];
    
    if (config.decayFactor <= 0.05) {
        characteristics.push('Very slow decay - suitable for large networks');
    } else if (config.decayFactor <= 0.1) {
        characteristics.push('Slow decay - good balance of reach and selectivity');
    } else if (config.decayFactor <= 0.15) {
        characteristics.push('Moderate decay - balanced approach');
    } else if (config.decayFactor <= 0.2) {
        characteristics.push('Fast decay - more selective trust');
    } else {
        characteristics.push('Very fast decay - highly localized trust');
    }
    
    const descriptions: Record<DecayProfileName, string> = {
        DEFAULT: 'Standard linear decay with 10% reduction per hop',
        CONSERVATIVE: 'Faster decay for more selective trust relationships',
        PROGRESSIVE: 'Slower decay for broader network reach',
        BALANCED: 'Moderate decay for balanced trust assessment',
        STRICT: 'Very fast decay for highly localized trust',
        EXTENDED: 'Very slow decay for network-wide trust assessment',
    };
    
    return {
        name,
        description: descriptions[name],
        decayFactor: config.decayFactor,
        maxDistance: config.maxDistance,
        selfWeight: config.selfWeight,
        zeroWeightThreshold,
        characteristics,
    };
}

/**
 * Get all decay profile metadata
 */
export function getAllDecayProfileMetadata(): DecayProfileMetadata[] {
    const metadata: DecayProfileMetadata[] = [];
    
    for (const name in DecayProfiles) {
        metadata.push(getDecayProfileMetadata(name as DecayProfileName));
    }
    
    return metadata;
}

/**
 * Find the best decay profile for a given use case
 */
export function recommendDecayProfile(useCase: 'social' | 'professional' | 'security' | 'exploration'): DecayProfileName {
    const recommendations: Record<typeof useCase, DecayProfileName> = {
        social: 'PROGRESSIVE',      // Broader reach for social networks
        professional: 'BALANCED',   // Balanced approach for professional networks
        security: 'CONSERVATIVE',   // More selective for security contexts
        exploration: 'EXTENDED',    // Maximum reach for network exploration
    };
    
    return recommendations[useCase];
}