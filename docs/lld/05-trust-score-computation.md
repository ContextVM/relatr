
# Low-Level Design: Trust Score Computation Module

## Overview

This module implements the composite trust ranking formula that combines all metrics (distance weight and profile validations) into a single trust score. It uses a flexible weighted formula that allows modular addition/removal of metrics and configurable weighting schemes.

## Trust Score Formula

From the HLD:

```
Trust Score = Σ(w_i × v_i^p_i) / Σ(w_i)
```

Where:
- `v_i`: Normalized metric values in [0, 1]
- `w_i`: Configurable metric weights (relative importance)
- `p_i`: Optional exponents for influence shaping (default 1.0)
- `Σ`: Sum over all enabled metrics

### Default Configuration (from HLD)

| Metric | Value Range | Weight (w_i) | Exponent (p_i) |
|--------|-------------|--------------|----------------|
| Relative Distance | [0, 1] | 0.5 | 1.0 |
| NIP-05 Valid | {0, 1} | 0.15 | 1.0 |
| Lightning Address | {0, 1} | 0.10 | 1.0 |
| Event Kind 10002 | {0, 1} | 0.10 | 1.0 |
| Reciprocity | {0, 1} | 0.15 | 1.0 |

**Total Weight**: 1.0 (normalized)

## Module Structure

```
src/trust/
├── TrustScoreCalculator.ts   # Main calculator
├── WeightingScheme.ts         # Weight configurations
├── TrustScoreCache.ts         # Database caching
├── types.ts                   # Type definitions
└── __tests__/
    └── TrustScoreCalculator.test.ts
```

## Implementation Details

### 1. TrustScoreCalculator Class

Main class for computing trust scores.

```typescript
import { Database } from 'bun:sqlite';
import type { WeightingScheme, MetricInputs, TrustScoreResult } from './types';
import { DefaultWeightingScheme } from './WeightingScheme';
import { TrustScoreCache } from './TrustScoreCache';

export interface TrustScoreConfig {
    weightingScheme?: WeightingScheme;
    cacheResults?: boolean;
    cacheTtlSeconds?: number;
}

export class TrustScoreCalculator {
    private db?: Database;
    private scheme: WeightingScheme;
    private cache?: TrustScoreCache;
    
    constructor(config?: TrustScoreConfig, db?: Database) {
        this.scheme = config?.weightingScheme || DefaultWeightingScheme;
        this.db = db;
        
        if (config?.cacheResults && db) {
            this.cache = new TrustScoreCache(
                db,
                config.cacheTtlSeconds || 3600
            );
        }
    }
    
    /**
     * Calculate trust score from metric inputs
     * 
     * @param inputs - All metric values (normalized to [0,1])
     * @param sourcePubkey - Optional source for caching
     * @param targetPubkey - Optional target for caching
     * @returns Trust score result
     */
    async calculate(
        inputs: MetricInputs,
        sourcePubkey?: string,
        targetPubkey?: string
    ): Promise<TrustScoreResult> {
        // Try cache first if enabled
        if (this.cache && sourcePubkey && targetPubkey) {
            const cached = await this.cache.get(sourcePubkey, targetPubkey);
            if (cached) {
                return cached;
            }
        }
        
        // Validate inputs
        this.validateInputs(inputs);
        
        // Calculate weighted sum
        const result = this.computeScore(inputs);
        
        // Cache if enabled
        if (this.cache && sourcePubkey && targetPubkey) {
            await this.cache.save(sourcePubkey, targetPubkey, result);
        }
        
        return result;
    }
    
    /**
     * Compute the trust score using the weighted formula
     */
    private computeScore(inputs: MetricInputs): TrustScoreResult {
        let weightedSum = 0;
        let totalWeight = 0;
        
        const metricValues: Record<string, number> = {};
        const metricWeights: Record<string, number> = {};
        
        // Process each metric
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            const value = (inputs as any)[metricName];
            
            // Skip if value is undefined or metric is disabled
            if (value === undefined || !config.enabled) {
                continue;
            }
            
            // Validate value is in [0,1]
            if (value < 0 || value > 1) {
                throw new Error(
                    `Metric ${metricName} value ${value} is out of range [0,1]`
                );
            }
            
            // Apply exponent (v_i^p_i)
            const transformedValue = Math.pow(value, config.exponent);
            
            // Apply weight (w_i × v_i^p_i)
            const contribution = config.weight * transformedValue;
            
            weightedSum += contribution;
            totalWeight += config.weight;
            
            // Store for result
            metricValues[metricName] = value;
            metricWeights[metricName] = config.weight;
        }
        
        // Avoid division by zero
        if (totalWeight === 0) {
            return {
                score: 0,
                metricValues,
                metricWeights,
                computedAt: Math.floor(Date.now() / 1000),
            };
        }
        
        // Calculate final score (normalized)
        const score = weightedSum / totalWeight;
        
        return {
            score: Math.max(0, Math.min(1, score)), // Clamp to [0,1]
            metricValues,
            metricWeights,
            computedAt: Math.floor(Date.now() / 1000),
        };
    }
    
    /**
     * Validate metric inputs
     */
    private validateInputs(inputs: MetricInputs): void {
        // Check that at least one metric is provided
        const hasAnyMetric = Object.keys(this.scheme.metrics).some(
            metricName => (inputs as any)[metricName] !== undefined
        );
        
        if (!hasAnyMetric) {
            throw new Error('No metric values provided');
        }
    }
    
    /**
     * Get the current weighting scheme
     */
    getWeightingScheme(): WeightingScheme {
        return { ...this.scheme };
    }
    
    /**
     * Update the weighting scheme
     */
    setWeightingScheme(scheme: WeightingScheme): void {
        this.validateWeightingScheme(scheme);
        this.scheme = scheme;
    }
    
    /**
     * Validate a weighting scheme
     */
    private validateWeightingScheme(scheme: WeightingScheme): void {
        for (const [metricName, config] of Object.entries(scheme.metrics)) {
            if (config.weight < 0) {
                throw new Error(
                    `Metric ${metricName} has negative weight ${config.weight}`
                );
            }
            
            if (config.exponent < 1) {
                throw new Error(
                    `Metric ${metricName} has invalid exponent ${config.exponent} (must be ≥ 1)`
                );
            }
        }
    }
    
    /**
     * Calculate score breakdown for analysis
     */
    calculateBreakdown(inputs: MetricInputs): MetricBreakdown[] {
        const breakdown: MetricBreakdown[] = [];
        let totalWeight = 0;
        
        // Calculate total weight for enabled metrics
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            if (config.enabled && (inputs as any)[metricName] !== undefined) {
                totalWeight += config.weight;
            }
        }
        
        // Calculate contribution for each metric
        for (const [metricName, config] of Object.entries(this.scheme.metrics)) {
            const value = (inputs as any)[metricName];
            
            if (value === undefined || !config.enabled) {
                continue;
            }
            
            const transformedValue = Math.pow(value, config.exponent);
            const contribution = config.weight * transformedValue;
            const normalizedContribution = totalWeight > 0 ? contribution / totalWeight : 0;
            
            breakdown.push({
                metric: metricName,
                value,
                weight: config.weight,
                exponent: config.exponent,
                transformedValue,
                contribution,
                normalizedContribution,
                percentageOfTotal: normalizedContribution * 100,
            });
        }
        
        return breakdown.sort((a, b) => b.contribution - a.contribution);
    }
    
    /**
     * Simulate score with different metric values
     */
    simulate(baseInputs: MetricInputs, variations: Partial<MetricInputs>): number {
        const combined = { ...baseInputs, ...variations };
        const result = this.computeScore(combined);
        return result.score;
    }
}
```

---

### 2. Weighting Schemes

Pre-defined and custom weighting configurations.

```typescript
import type { WeightingScheme, MetricConfig } from './types';

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
 * Get a weighting scheme by name
 */
export function getWeightingScheme(name: string): WeightingScheme {
    const schemes: Record<string, WeightingScheme> = {
        default: DefaultWeightingScheme,
        conservative: ConservativeScheme,
        progressive: ProgressiveScheme,
        balanced: BalancedScheme,
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
    const normalized = { ...scheme };
    
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
            if (normalized.metrics[metricName].enabled) {
                normalized.metrics[metricName].weight /= totalWeight;
            }
        }
    }
    
    return normalized;
}
```

---

### 3. Trust Score Cache

Database layer for caching computed trust scores.

```typescript
import { Database } from 'bun:sqlite';
import type { TrustScoreResult } from './types';

export class TrustScoreCache {
    private db: Database;
    private ttlSeconds: number;
    
    constructor(db: Database, ttlSeconds: number = 3600) {
        this.db = db;
        this.ttlSeconds = ttlSeconds;
    }
    
    /**
     * Get cached trust score
     */
    async get(sourcePubkey: string, targetPubkey: string): Promise<TrustScoreResult | null> {
        const query = this.db.query(`
            SELECT 
                ts.score,
                ts.metric_weights,
                ts.metric_values,
                ts.computed_at,
                ts.expires_at
            FROM trust_scores ts
            JOIN pubkeys sp ON ts.source_pubkey_id = sp.id
            JOIN pubkeys tp ON ts.target_pubkey_id = tp.id
            WHERE sp.pubkey = $sourcePubkey
                AND tp.pubkey = $targetPubkey
                AND (ts.expires_at IS NULL OR ts.expires_at > unixepoch())
            ORDER BY ts.computed_at DESC
            LIMIT 1
        `);
        
        const row = query.get({
            $sourcePubkey: sourcePubkey,
            $targetPubkey: targetPubkey,
        }) as any;
        
        if (!row) {
            return null;
        }
        
        return {
            score: row.score,
            metricValues: JSON.parse(row.metric_values),
            metricWeights: JSON.parse(row.metric_weights),
            computedAt: row.computed_at,
        };
    }
    
    /**
     * Save trust score to cache
     */
    async save(
        sourcePubkey: string,
        targetPubkey: string,
        result: TrustScoreResult
    ): Promise<void> {
        const transaction = this.db.transaction(() => {
            // Get or create pubkey IDs
            const sourceId = this.getOrCreatePubkeyId(sourcePubkey);
            const targetId = this.getOrCreatePubkeyId(targetPubkey);
            
            const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
            
            const query = this.db.query(`
                INSERT INTO trust_scores (
                    source_pubkey_id,
                    target_pubkey_id,
                    score,
                    computed_at,
                    expires_at,
                    metric_weights,
                    metric_values,
                    formula_version
                )
                VALUES ($sourceId, $targetId, $score, $computedAt, $expiresAt, $weights, $values, $version)
                ON CONFLICT(source_pubkey_id, target_pubkey_id, formula_version) DO UPDATE SET
                    score = $score,
                    computed_at = $computedAt,
                    expires_at = $expiresAt,
                    metric_weights = $weights,
                    metric_values = $values,
                    updated_at = unixepoch()
            `);
            
            query.run({
                $sourceId: sourceId,
                $targetId: targetId,
                $score: result.score,
                $computedAt: result.computedAt,
                $expiresAt: expiresAt,
                $weights: JSON.stringify(result.metricWeights),
                $values: JSON.stringify(result.metricValues),
                $version: 'v1',
            });
        });
        
        transaction();
    }
    
    /**
     * Invalidate cache for a pubkey pair
     */
    async invalidate(sourcePubkey: string, targetPubkey: string): Promise<void> {
        const query = this.db.query(`
            DELETE FROM trust_scores
            WHERE source_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $sourcePubkey)
                AND target_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $targetPubkey)
        `);
        
        query.run({
            $sourcePubkey: sourcePubkey,
            $targetPubkey: targetPubkey,
        });
    }
    
    /**
     * Invalidate all scores for a pubkey (as source or target)
     */
    async invalidateAll(pubkey: string): Promise<void> {
        const query = this.db.query(`
            DELETE FROM trust_scores
            WHERE source_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $pubkey)
                OR target_pubkey_id = (SELECT id FROM pubkeys WHERE pubkey = $pubkey)
        `);
        
        query.run({ $pubkey: pubkey });
    }
    
    // Private helper methods
    
    private getOrCreatePubkeyId(pubkey: string): number {
        const selectQuery = this.db.query(`
            SELECT id FROM pubkeys WHERE pubkey = $pubkey
        `);
        
        const existing = selectQuery.get({ $pubkey: pubkey }) as any;
        if (existing) {
            return existing.id;
        }
        
        const insertQuery = this.db.query(`
            INSERT INTO pubkeys (pubkey, first_seen_at, last_updated_at)
            VALUES ($pubkey, unixepoch(), unixepoch())
        `);
        
        const result = insertQuery.run({ $pubkey: pubkey });
        return result.lastInsertRowid as number;
    }
}
```

---

### 4. Type Definitions

```typescript
/**
 * All metric inputs for trust score calculation
 */
export interface MetricInputs {
    distanceWeight: number;       // From DistanceNormalizer
    nip05Valid: number;           // From ProfileMetricsCollector
    lightningAddress: number;     // From ProfileMetricsCollector
    eventKind10002: number;       // From ProfileMetricsCollector
    reciprocity: number;          // From ProfileMetricsCollector
}

/**
 * Configuration for a single metric
 */
export interface MetricConfig {
    weight: number;      // w_i in the formula
    exponent: number;    // p_i in the formula (default 1.0)
    enabled: boolean;    // Whether to include this metric
}

/**
 * Weighting scheme configuration
 */
export interface WeightingScheme {
    name: string;
    version: string;
    metrics: Record<string, MetricConfig>;
}

/**
 * Trust score calculation result
 */
export interface TrustScoreResult {
    score: number;                          // Final trust score [0,1]
    metricValues: Record<string, number>;   // Input metric values used
    metricWeights: Record<string, number>;  // Weights used
    computedAt: number;                     // Unix timestamp
}

/**
 * Detailed breakdown of score calculation
 */
export interface MetricBreakdown {
    metric: string;
    value: number;
    weight: number;
    exponent: number;
    transformedValue: number;
    contribution: number;
    normalizedContribution: number;
    percentageOfTotal: number;
}
```

---

## Usage Examples

### Basic Usage

```typescript
import { TrustScoreCalculator } from './trust/TrustScoreCalculator';
import { Database } from 'bun:sqlite';

const db = new Database('relatr.db');

const calculator = new TrustScoreCalculator({
    cacheResults: true,
    cacheTtlSeconds: 3600,
}, db);

// Calculate trust score
const result = await calculator.calculate({
    distanceWeight: 0.8,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 0.0,
    reciprocity: 1.0,
}, 'source-pubkey...', 'target-pubkey...');

console.log(`Trust Score: ${result.score.toFixed(3)}`);
console.log('Metrics used:', result.metricValues);
console.log('Weights used:', result.metricWeights);
```

### Using Different Weighting Schemes

```typescript
import { TrustScoreCalculator } from './trust/TrustScoreCalculator';
import { ConservativeScheme, ProgressiveScheme } from './trust/WeightingScheme';

// Conservative approach (emphasizes distance)
const conservativeCalc = new TrustScoreCalculator({
    weightingScheme: ConservativeScheme,
});

// Progressive approach (emphasizes validations)
const progressiveCalc = new TrustScoreCalculator({
    weightingScheme: ProgressiveScheme,
});

const inputs = {
    distanceWeight: 0.5,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 1.0,
    reciprocity: 0.0,
};

const conservativeScore = await conservativeCalc.calculate(inputs);
const progressiveScore = await progressiveCalc.calculate(inputs);

console.log(`Conservative: ${conservativeScore.score.toFixed(3)}`);
console.log(`Progressive: ${progressiveScore.score.toFixed(3)}`);
```

### Score Breakdown Analysis

```typescript
const calculator = new TrustScoreCalculator();

const breakdown = calculator.calculateBreakdown({
    distanceWeight: 0.8,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 0.0,
    reciprocity: 1.0,
});

console.log('Score Breakdown:');
for (const item of breakdown) {
    console.log(
        `${item.metric.padEnd(20)} | ` +
        `Value: ${item.value.toFixed(2)} | ` +
        `Weight: ${item.weight.toFixed(2)} | ` +
        `Contribution: ${item.percentageOfTotal.toFixed(1)}%`
    );
}
```

Output:
```
Score Breakdown:
distanceWeight       | Value: 0.80 | Weight: 0.50 | Contribution: 44.4%
nip05Valid           | Value: 1.00 | Weight: 0.15 | Contribution: 16.7%
reciprocity          | Value: 1.00 | Weight: 0.15 | Contribution: 16.7%
lightningAddress     | Value: 1.00 | Weight: 0.10 | Contribution: 11.1%
eventKind10002       | Value: 0.00 | Weight: 0.10 | Contribution: 0.0%
```

### Full Integration Example

```typescript
import { SocialGraphManager } from './social-graph/SocialGraphManager';
import { DistanceNormalizer } from './distance/DistanceNormalizer';
import { ProfileMetricsCollector } from './metrics/ProfileMetricsCollector';
import { TrustScoreCalculator } from './trust/TrustScoreCalculator';
import { Database } from 'bun:sqlite';

const db = new Database('relatr.db');

// Initialize all components
const graph = new SocialGraphManager({
    rootPubkey: sourcePubkey,
    graphBinaryPath: 'data/socialGraph.bin',
});
await graph.initialize();

const normalizer = new DistanceNormalizer();
const metricsCollector = new ProfileMetricsCollector(db, {
    relays: ['wss://relay.damus.io'],
    cacheTtlSeconds: 3600,
    enableNip05: true,
    enableLightning: true,
    enableEventKind10002: true,
    enableReciprocity: true,
});

const calculator = new TrustScoreCalculator({ cacheResults: true }, db);

// Calculate trust score for a target
const targetPubkey = 'target-hex...';

// 1. Get social graph distance
const distance = graph.getFollowDistance(targetPubkey);
const distanceWeight = normalizer.normalize(distance);

// 2. Get profile metrics
const profileMetrics = await metricsCollector.collectMetrics(targetPubkey, sourcePubkey);

// 3. Calculate trust score
const trustScore = await calculator.calculate({
    distanceWeight,
    nip05Valid: profileMetrics.nip05Valid,
    lightningAddress: profileMetrics.lightningAddress,
    eventKind10002: profileMetrics.eventKind10002,
    reciprocity: profileMetrics.reciprocity,
}, sourcePubkey, targetPubkey);

console.log(`Trust Score: ${trustScore.score.toFixed(3)}`);
```

---

## Configuration Management

### Loading from Database

```typescript
import { Database } from 'bun:sqlite';
import type { WeightingScheme } from './types';

function loadWeightingSchemeFromDB(db: Database): WeightingScheme {
    const query = db.query(`
        SELECT metric_name, default_weight, default_exponent, is_active
        FROM metric_definitions
    `);
    
    const rows = query.all() as Array<{
        metric_name: string;
        default_weight: number;
        default_exponent: number;
        is_active: number;
    }>;
    
    const scheme: WeightingScheme = {
        name: 'database',
        version: 'v1',
        metrics: {},
    };
    
    for (const row of rows) {
        const metricKey = row.metric_name
            .split('_')
            .map((part, i) => i === 0 ? part : part[0].toUpperCase() + part.slice(1))
            .join('');
        
        scheme.metrics[metricKey] = {
            weight: row.default_weight,
            exponent: row.default_exponent,
            enabled: row.is_active === 1,
        };
    }
    
    return scheme;
}
```

---