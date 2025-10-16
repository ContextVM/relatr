import type { WeightingScheme, MetricConfig, WeightingSchemeMetadata } from './types';

/**
 * Default weighting scheme from HLD
 */
export const DefaultWeightingScheme: WeightingScheme = {
    name: 'default',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.5,
            exponent: 1.0,
            enabled: true,
        },
        nip05Valid: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
        lightningAddress: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
    },
};

/**
 * Conservative scheme - emphasizes distance heavily
 */
export const ConservativeScheme: WeightingScheme = {
    name: 'conservative',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.7,
            exponent: 1.0,
            enabled: true,
        },
        nip05Valid: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        lightningAddress: {
            weight: 0.05,
            exponent: 1.0,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.05,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
    },
};

/**
 * Progressive scheme - emphasizes validations over distance
 */
export const ProgressiveScheme: WeightingScheme = {
    name: 'progressive',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.3,
            exponent: 1.0,
            enabled: true,
        },
        nip05Valid: {
            weight: 0.25,
            exponent: 1.0,
            enabled: true,
        },
        lightningAddress: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
    },
};

/**
 * Balanced scheme - equal weight to all categories
 */
export const BalancedScheme: WeightingScheme = {
    name: 'balanced',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
        nip05Valid: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
        lightningAddress: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
    },
};

/**
 * Validation-focused scheme - emphasizes profile validations
 */
export const ValidationFocusedScheme: WeightingScheme = {
    name: 'validation-focused',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.2,
            exponent: 1.0,
            enabled: true,
        },
        nip05Valid: {
            weight: 0.3,
            exponent: 1.2, // Higher exponent to reward NIP-05 more
            enabled: true,
        },
        lightningAddress: {
            weight: 0.2,
            exponent: 1.1,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
    },
};

/**
 * Social proof scheme - emphasizes reciprocity and social connections
 */
export const SocialProofScheme: WeightingScheme = {
    name: 'social-proof',
    version: 'v1',
    metrics: {
        distanceWeight: {
            weight: 0.4,
            exponent: 0.8, // Lower exponent to reduce distance impact
            enabled: true,
        },
        nip05Valid: {
            weight: 0.15,
            exponent: 1.0,
            enabled: true,
        },
        lightningAddress: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        eventKind10002: {
            weight: 0.1,
            exponent: 1.0,
            enabled: true,
        },
        reciprocity: {
            weight: 0.25,
            exponent: 1.3, // Higher exponent to reward reciprocity more
            enabled: true,
        },
    },
};

/**
 * Get a weighting scheme by name
 */
export function getWeightingScheme(name: string): WeightingScheme {
    const schemes: Record<string, WeightingScheme> = {
        default: DefaultWeightingScheme,
        conservative: ConservativeScheme,
        progressive: ProgressiveScheme,
        balanced: BalancedScheme,
        'validation-focused': ValidationFocusedScheme,
        'social-proof': SocialProofScheme,
    };
    
    const scheme = schemes[name.toLowerCase()];
    if (!scheme) {
        throw new Error(`Unknown weighting scheme: ${name}`);
    }
    
    return { ...scheme };
}

/**
 * Create a custom weighting scheme
 */
export function createCustomScheme(
    name: string,
    metrics: Record<string, Partial<MetricConfig>>
): WeightingScheme {
    const scheme: WeightingScheme = {
        name,
        version: 'custom',
        metrics: {},
    };
    
    // Fill in defaults
    for (const [metricName, config] of Object.entries(metrics)) {
        scheme.metrics[metricName] = {
            weight: config.weight ?? 0.2,
            exponent: config.exponent ?? 1.0,
            enabled: config.enabled ?? true,
        };
    }
    
    return scheme;
}

/**
 * Normalize weights to sum to 1.0
 */
export function normalizeWeights(scheme: WeightingScheme): WeightingScheme {
    const normalized = JSON.parse(JSON.stringify(scheme)) as WeightingScheme;
    
    // Calculate total weight
    let totalWeight = 0;
    for (const config of Object.values(scheme.metrics)) {
        if (config.enabled) {
            totalWeight += config.weight;
        }
    }
    
    // Normalize each weight
    if (totalWeight > 0) {
        for (const metricName of Object.keys(normalized.metrics)) {
            const metric = normalized.metrics[metricName];
            if (metric && metric.enabled) {
                metric.weight /= totalWeight;
            }
        }
    }
    
    return normalized;
}

/**
 * Validate a weighting scheme
 */
export function validateWeightingScheme(scheme: WeightingScheme): string[] {
    const errors: string[] = [];
    
    // Check if scheme has a name
    if (!scheme.name || scheme.name.trim() === '') {
        errors.push('Weighting scheme must have a name');
    }
    
    // Check if scheme has a version
    if (!scheme.version || scheme.version.trim() === '') {
        errors.push('Weighting scheme must have a version');
    }
    
    // Check if scheme has metrics
    if (!scheme.metrics || Object.keys(scheme.metrics).length === 0) {
        errors.push('Weighting scheme must have at least one metric');
        return errors;
    }
    
    // Check each metric
    for (const [metricName, config] of Object.entries(scheme.metrics)) {
        if (config.weight < 0) {
            errors.push(`Metric ${metricName} has negative weight ${config.weight}`);
        }
        
        if (config.exponent < 1) {
            errors.push(`Metric ${metricName} has invalid exponent ${config.exponent} (must be ≥ 1)`);
        }
        
        if (config.weight > 0 && !config.enabled) {
            errors.push(`Metric ${metricName} has positive weight but is disabled`);
        }
    }
    
    // Check if at least one metric is enabled
    const hasEnabledMetrics = Object.values(scheme.metrics).some(config => config.enabled);
    if (!hasEnabledMetrics) {
        errors.push('At least one metric must be enabled');
    }
    
    return errors;
}

/**
 * Get metadata for a weighting scheme
 */
export function getWeightingSchemeMetadata(scheme: WeightingScheme): WeightingSchemeMetadata {
    const metadata: Record<string, WeightingSchemeMetadata> = {
        default: {
            name: 'default',
            version: 'v1',
            description: 'Balanced scheme with moderate emphasis on social distance',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['balanced', 'default'],
            isDefault: true,
        },
        conservative: {
            name: 'conservative',
            version: 'v1',
            description: 'Emphasizes social distance heavily, conservative approach to trust',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['conservative', 'distance-focused'],
            isDefault: false,
        },
        progressive: {
            name: 'progressive',
            version: 'v1',
            description: 'Emphasizes profile validations over social distance',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['progressive', 'validation-focused'],
            isDefault: false,
        },
        balanced: {
            name: 'balanced',
            version: 'v1',
            description: 'Equal weight to all metrics categories',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['balanced', 'equal-weight'],
            isDefault: false,
        },
        'validation-focused': {
            name: 'validation-focused',
            version: 'v1',
            description: 'Heavily emphasizes profile validations with higher exponents',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['validation', 'profile-focused'],
            isDefault: false,
        },
        'social-proof': {
            name: 'social-proof',
            version: 'v1',
            description: 'Emphasizes reciprocity and social connections',
            author: 'Relatr Team',
            createdAt: Date.now(),
            tags: ['social', 'reciprocity-focused'],
            isDefault: false,
        },
    };
    
    return metadata[scheme.name] || {
        name: scheme.name,
        version: scheme.version,
        description: 'Custom weighting scheme',
        createdAt: Date.now(),
        tags: ['custom'],
        isDefault: false,
    };
}

/**
 * Get all available weighting schemes
 */
export function getAllWeightingSchemes(): WeightingScheme[] {
    return [
        DefaultWeightingScheme,
        ConservativeScheme,
        ProgressiveScheme,
        BalancedScheme,
        ValidationFocusedScheme,
        SocialProofScheme,
    ];
}

/**
 * Get all available weighting scheme names
 */
export function getWeightingSchemeNames(): string[] {
    return getAllWeightingSchemes().map(scheme => scheme.name);
}

/**
 * Compare two weighting schemes
 */
export function compareWeightingSchemes(
    scheme1: WeightingScheme,
    scheme2: WeightingScheme
): {
    added: string[];
    removed: string[];
    modified: Array<{
        metric: string;
        oldWeight: number;
        newWeight: number;
        oldExponent: number;
        newExponent: number;
        oldEnabled: boolean;
        newEnabled: boolean;
    }>;
} {
    const metrics1 = new Set(Object.keys(scheme1.metrics));
    const metrics2 = new Set(Object.keys(scheme2.metrics));
    
    const added = [...metrics2].filter(metric => !metrics1.has(metric));
    const removed = [...metrics1].filter(metric => !metrics2.has(metric));
    
    const modified = [];
    for (const metric of [...metrics1].filter(metric => metrics2.has(metric))) {
        const config1 = scheme1.metrics[metric];
        const config2 = scheme2.metrics[metric];
        
        if (config1 && config2 && (
            config1.weight !== config2.weight ||
            config1.exponent !== config2.exponent ||
            config1.enabled !== config2.enabled
        )) {
            modified.push({
                metric,
                oldWeight: config1.weight,
                newWeight: config2.weight,
                oldExponent: config1.exponent,
                newExponent: config2.exponent,
                oldEnabled: config1.enabled,
                newEnabled: config2.enabled,
            });
        }
    }
    
    return { added, removed, modified };
}