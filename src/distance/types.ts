/**
 * Type definitions for distance normalization module
 */

/**
 * Configuration for distance normalization
 */
export interface DistanceNormalizerConfig {
    decayFactor: number;      // Alpha (α) in the formula
    maxDistance: number;      // Distance considered unreachable (default 1000)
    selfWeight: number;       // Weight for distance 0 (default 1.0)
}

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

/**
 * Decay profile metadata
 */
export interface DecayProfileMetadata {
    name: string;
    description: string;
    decayFactor: number;
    maxDistance: number;
    selfWeight: number;
    zeroWeightThreshold: number;
    characteristics: string[];
}

/**
 * Visualization data for decay curves
 */
export interface DecayVisualizationData {
    profile: string;
    points: Array<[number, number]>;
    metadata: DecayProfileMetadata;
}