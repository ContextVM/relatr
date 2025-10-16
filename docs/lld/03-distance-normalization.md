# Low-Level Design: Distance Calculation and Normalization Module

## Overview

This module handles the conversion of raw integer social graph distances (hops) into normalized floating-point weights suitable for trust score calculation. It implements the linear decay formula specified in the HLD and provides configurable parameters for different trust decay profiles.

## Key Concepts

1. **Raw Distance**: Integer hop count from social graph (0, 1, 2, ..., 1000)
2. **Normalization**: Convert integer to floating-point score (0.0 - 1.0)
3. **Linear Decay**: Apply decay factor to reduce trust as distance increases
4. **Configurable**: Allow tuning of decay parameters for different use cases

## Normalization Formula

From the HLD:

```
Distance Weight = max(0, 1 - α × (distance - 1))
```

Where:
- `distance`: Integer hop count from social graph (1, 2, 3, ...)
- `α` (alpha): Decay factor (default 0.1)
- Result: Floating-point value in [0, 1]

### Examples with α = 0.1

| Distance (hops) | Calculation | Weight |
|-----------------|-------------|--------|
| 0 (self) | Special case | 1.0 |
| 1 (direct follow) | 1 - 0.1×(1-1) = 1.0 | 1.0 |
| 2 | 1 - 0.1×(2-1) = 0.9 | 0.9 |
| 3 | 1 - 0.1×(3-1) = 0.8 | 0.8 |
| 5 | 1 - 0.1×(5-1) = 0.6 | 0.6 |
| 10 | 1 - 0.1×(10-1) = 0.1 | 0.1 |
| 11 | 1 - 0.1×(11-1) = 0.0 | 0.0 |
| 1000 (unreachable) | max(0, ...) = 0.0 | 0.0 |

## Module Structure

```
src/distance/
├── DistanceNormalizer.ts      # Main normalization class
├── DecayProfiles.ts           # Pre-defined decay configurations
├── types.ts                   # Type definitions
└── __tests__/
    └── DistanceNormalizer.test.ts
```

## Implementation Details

### 1. DistanceNormalizer Class

Main class for distance normalization with configurable decay.

```typescript
/**
 * Configuration for distance normalization
 */
export interface DistanceNormalizerConfig {
    decayFactor: number;      // Alpha (α) in the formula
    maxDistance: number;      // Distance considered unreachable (default 1000)
    selfWeight: number;       // Weight for distance 0 (default 1.0)
}

/**
 * Normalizes social graph distances to floating-point weights
 */
export class DistanceNormalizer {
    private config: DistanceNormalizerConfig;
    
    constructor(config?: Partial<DistanceNormalizerConfig>) {
        // Set defaults
        this.config = {
            decayFactor: config?.decayFactor ?? 0.1,
            maxDistance: config?.maxDistance ?? 1000,
            selfWeight: config?.selfWeight ?? 1.0,
        };
        
        // Validate configuration
        this.validateConfig();
    }
    
    /**
     * Normalize a single distance to a weight
     * 
     * @param distance - Integer hop count from social graph
     * @returns Normalized weight in [0, 1]
     */
    normalize(distance: number): number {
        // Validate input
        if (!Number.isInteger(distance) || distance < 0) {
            throw new Error(`Invalid distance: ${distance}. Must be non-negative integer.`);
        }
        
        // Special case: distance to self
        if (distance === 0) {
            return this.config.selfWeight;
        }
        
        // Unreachable (distance >= maxDistance)
        if (distance >= this.config.maxDistance) {
            return 0.0;
        }
        
        // Apply linear decay formula
        const weight = 1.0 - this.config.decayFactor * (distance - 1);
        
        // Clamp to [0, 1]
        return Math.max(0.0, Math.min(1.0, weight));
    }
    
    /**
     * Normalize multiple distances at once
     * 
     * @param distances - Map of pubkey to distance
     * @returns Map of pubkey to weight
     */
    normalizeMany(distances: Map<string, number>): Map<string, number> {
        const weights = new Map<string, number>();
        
        for (const [pubkey, distance] of distances) {
            weights.set(pubkey, this.normalize(distance));
        }
        
        return weights;
    }
    
    /**
     * Get the distance threshold where weight becomes zero
     * 
     * @returns Distance at which weight = 0
     */
    getZeroWeightThreshold(): number {
        // Solve: 0 = 1 - α(d - 1)
        // α(d - 1) = 1
        // d - 1 = 1/α
        // d = 1 + 1/α
        
        const threshold = 1 + (1 / this.config.decayFactor);
        return Math.ceil(threshold);
    }
    
    /**
     * Get weight at a specific distance without normalization
     * Useful for understanding the decay curve
     */
    getRawWeight(distance: number): number {
        if (distance === 0) return this.config.selfWeight;
        if (distance >= this.config.maxDistance) return 0.0;
        
        return 1.0 - this.config.decayFactor * (distance - 1);
    }
    
    /**
     * Check if a distance is considered "reachable"
     */
    isReachable(distance: number): boolean {
        return distance < this.config.maxDistance && distance >= 0;
    }
    
    /**
     * Get current configuration
     */
    getConfig(): DistanceNormalizerConfig {
        return { ...this.config };
    }
    
    /**
     * Update configuration
     */
    updateConfig(updates: Partial<DistanceNormalizerConfig>): void {
        this.config = {
            ...this.config,
            ...updates,
        };
        this.validateConfig();
    }
    
    /**
     * Validate configuration parameters
     */
    private validateConfig(): void {
        const { decayFactor, maxDistance, selfWeight } = this.config;
        
        if (decayFactor <= 0) {
            throw new Error(`decayFactor must be positive, got ${decayFactor}`);
        }
        
        if (decayFactor > 1) {
            console.warn(`decayFactor ${decayFactor} > 1 may produce negative weights`);
        }
        
        if (maxDistance <= 0) {
            throw new Error(`maxDistance must be positive, got ${maxDistance}`);
        }
        
        if (selfWeight < 0 || selfWeight > 1) {
            throw new Error(`selfWeight must be in [0,1], got ${selfWeight}`);
        }
    }
    
    /**
     * Generate a decay curve for visualization
     * 
     * @param maxDist - Maximum distance to generate
     * @returns Array of [distance, weight] pairs
     */
    generateDecayCurve(maxDist: number = 20): Array<[number, number]> {
        const curve: Array<[number, number]> = [];
        
        for (let d = 0; d <= maxDist; d++) {
            curve.push([d, this.normalize(d)]);
        }
        
        return curve;
    }
}
```

---

### 2. Pre-defined Decay Profiles

Common decay configurations for different trust scenarios.

```typescript
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
     * Strict profile (α = 0.2)
     * Faster decay, more selective trust
     * Weight drops 20% per hop
     * Zero at ~6 hops
     */
    STRICT: {
        decayFactor: 0.2,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Lenient profile (α = 0.05)
     * Slower decay, broader trust network
     * Weight drops 5% per hop
     * Zero at ~21 hops
     */
    LENIENT: {
        decayFactor: 0.05,
        maxDistance: 1000,
        selfWeight: 1.0,
    },
    
    /**
     * Exponential-like (α = 0.3)
     * Very fast decay, highly localized trust
     * Weight drops 30% per hop
     * Zero at ~4 hops
     */
    EXPONENTIAL: {
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
 * Get a decay profile by name
 */
export function getDecayProfile(
    name: keyof typeof DecayProfiles
): DistanceNormalizerConfig {
    return { ...DecayProfiles[name] };
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
```

---

### 3. Type Definitions

```typescript
/**
 * Distance normalization result
 */
export interface NormalizationResult {
    distance: number;
    weight: number;
    isReachable: boolean;
}

/**
 * Batch normalization result
 */
export interface BatchNormalizationResult {
    pubkey: string;
    distance: number;
    weight: number;
    isReachable: boolean;
}

/**
 * Decay curve point
 */
export interface DecayCurvePoint {
    distance: number;
    weight: number;
}
```

---

## Usage Examples

### Basic Usage

```typescript
import { DistanceNormalizer } from './distance/DistanceNormalizer';

// Create normalizer with default settings (α = 0.1)
const normalizer = new DistanceNormalizer();

// Normalize a distance
const weight = normalizer.normalize(3);
console.log(weight); // 0.8

// Check if reachable
console.log(normalizer.isReachable(5)); // true
console.log(normalizer.isReachable(1000)); // false

// Get zero threshold
const threshold = normalizer.getZeroWeightThreshold();
console.log(threshold); // 11
```

### Using Decay Profiles

```typescript
import { DistanceNormalizer } from './distance/DistanceNormalizer';
import { DecayProfiles, getDecayProfile } from './distance/DecayProfiles';

// Use strict profile
const strictNormalizer = new DistanceNormalizer(DecayProfiles.STRICT);

// Use lenient profile
const lenientNormalizer = new DistanceNormalizer(getDecayProfile('LENIENT'));

// Compare results
console.log('Distance 5:');
console.log('  Strict:', strictNormalizer.normalize(5));   // 0.2
console.log('  Lenient:', lenientNormalizer.normalize(5)); // 0.8
```

### Batch Normalization

```typescript
import { DistanceNormalizer } from './distance/DistanceNormalizer';

const normalizer = new DistanceNormalizer();

// Normalize multiple distances
const distances = new Map([
    ['alice', 1],
    ['bob', 3],
    ['charlie', 5],
    ['dave', 1000],
]);

const weights = normalizer.normalizeMany(distances);

for (const [pubkey, weight] of weights) {
    console.log(`${pubkey}: ${weight}`);
}
// alice: 1.0
// bob: 0.8
// charlie: 0.6
// dave: 0.0
```

### Integration with Social Graph

```typescript
import { SocialGraphManager } from './social-graph/SocialGraphManager';
import { DistanceNormalizer } from './distance/DistanceNormalizer';

// Initialize graph and normalizer
const graph = new SocialGraphManager({ /* config */ });
await graph.initialize();

const normalizer = new DistanceNormalizer();

// Get distance from graph
const targetPubkey = 'target-hex...';
const distance = graph.getFollowDistance(targetPubkey);

// Normalize to weight
const weight = normalizer.normalize(distance);

console.log(`Distance: ${distance} hops → Weight: ${weight}`);
```

### Visualizing Decay Curve

```typescript
import { DistanceNormalizer } from './distance/DistanceNormalizer';

const normalizer = new DistanceNormalizer();

// Generate decay curve
const curve = normalizer.generateDecayCurve(15);

console.log('Distance | Weight');
console.log('---------|-------');
for (const [distance, weight] of curve) {
    console.log(`${distance.toString().padStart(8)} | ${weight.toFixed(2)}`);
}
```

Output:
```
Distance | Weight
---------|-------
       0 | 1.00
       1 | 1.00
       2 | 0.90
       3 | 0.80
       4 | 0.70
       5 | 0.60
       6 | 0.50
       7 | 0.40
       8 | 0.30
       9 | 0.20
      10 | 0.10
      11 | 0.00
      12 | 0.00
      13 | 0.00
      14 | 0.00
      15 | 0.00
```

---

## Configuration Management

### Loading from Environment Variables

```typescript
import { DistanceNormalizer } from './distance/DistanceNormalizer';

function createNormalizerFromEnv(): DistanceNormalizer {
    const decayFactor = parseFloat(process.env.DISTANCE_DECAY_FACTOR ?? '0.1');
    const maxDistance = parseInt(process.env.MAX_DISTANCE ?? '1000', 10);
    const selfWeight = parseFloat(process.env.SELF_WEIGHT ?? '1.0');
    
    return new DistanceNormalizer({
        decayFactor,
        maxDistance,
        selfWeight,
    });
}

const normalizer = createNormalizerFromEnv();
```

### Loading from Database Configuration

```typescript
import { Database } from 'bun:sqlite';
import { DistanceNormalizer } from './distance/DistanceNormalizer';

function loadNormalizerConfig(db: Database): DistanceNormalizer {
    const query = db.query(`
        SELECT config_key, config_value 
        FROM configuration 
        WHERE config_key IN ('distance_decay_factor', 'max_distance')
    `);
    
    const rows = query.all() as Array<{ config_key: string; config_value: string }>;
    
    const config: any = {
        decayFactor: 0.1,
        maxDistance: 1000,
    };
    
    for (const row of rows) {
        if (row.config_key === 'distance_decay_factor') {
            config.decayFactor = parseFloat(row.config_value);
        } else if (row.config_key === 'max_distance') {
            config.maxDistance = parseInt(row.config_value, 10);
        }
    }
    
    return new DistanceNormalizer(config);
}
```

---

## Testing

### Unit Tests

```typescript
import { describe, it, expect } from 'bun:test';
import { DistanceNormalizer } from '../DistanceNormalizer';
import { DecayProfiles } from '../DecayProfiles';

describe('DistanceNormalizer', () => {
    describe('normalize', () => {
        it('should return 1.0 for distance 0', () => {
            const normalizer = new DistanceNormalizer();
            expect(normalizer.normalize(0)).toBe(1.0);
        });
        
        it('should return 1.0 for distance 1', () => {
            const normalizer = new DistanceNormalizer();
            expect(normalizer.normalize(1)).toBe(1.0);
        });
        
        it('should apply linear decay correctly', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.1 });
            expect(normalizer.normalize(2)).toBe(0.9);
            expect(normalizer.normalize(3)).toBe(0.8);
            expect(normalizer.normalize(5)).toBe(0.6);
        });
        
        it('should return 0.0 for unreachable distance', () => {
            const normalizer = new DistanceNormalizer();
            expect(normalizer.normalize(1000)).toBe(0.0);
            expect(normalizer.normalize(9999)).toBe(0.0);
        });
        
        it('should clamp negative results to 0', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.1 });
            expect(normalizer.normalize(15)).toBe(0.0);
        });
        
        it('should throw on invalid distance', () => {
            const normalizer = new DistanceNormalizer();
            expect(() => normalizer.normalize(-1)).toThrow();
            expect(() => normalizer.normalize(1.5)).toThrow();
        });
    });
    
    describe('decay profiles', () => {
        it('should apply strict profile correctly', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.STRICT);
            expect(normalizer.normalize(2)).toBe(0.8); // 1 - 0.2×1
            expect(normalizer.normalize(6)).toBe(0.0); // 1 - 0.2×5
        });
        
        it('should apply lenient profile correctly', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.LENIENT);
            expect(normalizer.normalize(2)).toBe(0.95); // 1 - 0.05×1
            expect(normalizer.normalize(5)).toBe(0.8);  // 1 - 0.05×4
        });
    });
    
    describe('getZeroWeightThreshold', () => {
        it('should calculate correct threshold for default', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.1 });
            expect(normalizer.getZeroWeightThreshold()).toBe(11);
        });
        
        it('should calculate correct threshold for strict', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.2 });
            expect(normalizer.getZeroWeightThreshold()).toBe(6);
        });
    });
    
    describe('normalizeMany', () => {
        it('should normalize multiple distances', () => {
            const normalizer = new DistanceNormalizer();
            const distances = new Map([
                ['a', 1],
                ['b', 3],
                ['c', 1000],
            ]);
            
            const weights = normalizer.normalizeMany(distances);
            
            expect(weights.get('a')).toBe(1.0);
            expect(weights.get('b')).toBe(0.8);
            expect(weights.get('c')).toBe(0.0);
        });
    });
});
```

---

## Performance Considerations

1. **Lightweight Calculations**: Simple arithmetic operations, extremely fast
2. **No External Dependencies**: Pure mathematical computation
3. **Immutable by Default**: Thread-safe for concurrent use
4. **Pre-computed Profiles**: Common configurations readily available
5. **Batch Operations**: Efficient map-based batch normalization

---

## Alternative Decay Functions

While the current implementation uses linear decay, the module can be extended to support other decay functions:

### Exponential Decay

```typescript
// Weight = e^(-α × distance)
normalizeExponential(distance: number): number {
    if (distance === 0) return this.config.selfWeight;
    if (distance >= this.config.maxDistance) return 0.0;
    
    const weight = Math.exp(-this.config.decayFactor * distance);
    return Math.max(0.0, weight);
}
```

### Power Decay

```typescript
// Weight = (1 / distance)^α
normalizePower(distance: number): number {
    if (distance === 0) return this.config.selfWeight;
    if (distance >= this.config.maxDistance) return 0.0;
    
    const weight = Math.pow(1 / distance, this.config.decayFactor);
    return Math.max(0.0, Math.min(1.0, weight));
}
```

### Sigmoid Decay

```typescript
// Weight = 1 / (1 + e^(α × (distance - β)))
normalizeSigmoid(distance: number, midpoint: number = 5): number {
    if (distance === 0) return this.config.selfWeight;
    if (distance >= this.config.maxDistance) return 0.0;
    
    const weight = 1 / (1 + Math.exp(this.config.decayFactor * (distance - midpoint)));
    return weight;
}
```

---

## Future Enhancements

1. **Multiple Decay Functions**: Support pluggable decay strategies
2. **Adaptive Decay**: Adjust decay based on network characteristics
3. **Personalized Profiles**: Per-user decay preferences
4. **Confidence Intervals**: Weight ranges instead of point estimates
5. **Decay Visualization**: Built-in charting for decay curves

---

## Summary

The Distance Normalization module provides:

- ✅ Clean conversion from integer hops to floating-point weights
- ✅ Configurable linear decay via alpha parameter
- ✅ Pre-defined profiles for common use cases
- ✅ Validation and error handling
- ✅ Batch processing support
- ✅ Integration-ready for trust score calculation
- ✅ Extensible for alternative decay functions

The module is stateless, lightweight, and can be used across the application for consistent distance-to-weight conversion.