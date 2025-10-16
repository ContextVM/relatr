import { describe, it, expect, beforeEach } from 'bun:test';
import {
    DefaultWeightingScheme,
    ConservativeScheme,
    ProgressiveScheme,
    BalancedScheme,
    ValidationFocusedScheme,
    SocialProofScheme,
    getWeightingScheme,
    createCustomScheme,
    normalizeWeights,
    validateWeightingScheme,
    getWeightingSchemeMetadata,
    getAllWeightingSchemes,
    getWeightingSchemeNames,
    compareWeightingSchemes,
} from '../WeightingScheme';
import type { WeightingScheme } from '../types';

describe('WeightingScheme', () => {
    describe('Predefined Schemes', () => {
        it('should have valid default scheme', () => {
            expect(DefaultWeightingScheme.name).toBe('default');
            expect(DefaultWeightingScheme.version).toBe('v1');
            expect(Object.keys(DefaultWeightingScheme.metrics)).toHaveLength(5);
            
            // Check specific weights
            expect(DefaultWeightingScheme.metrics.distanceWeight?.weight).toBe(0.5);
            expect(DefaultWeightingScheme.metrics.nip05Valid?.weight).toBe(0.15);
            expect(DefaultWeightingScheme.metrics.lightningAddress?.weight).toBe(0.1);
            expect(DefaultWeightingScheme.metrics.eventKind10002?.weight).toBe(0.1);
            expect(DefaultWeightingScheme.metrics.reciprocity?.weight).toBe(0.15);
        });

        it('should have valid conservative scheme', () => {
            expect(ConservativeScheme.name).toBe('conservative');
            expect(ConservativeScheme.metrics.distanceWeight?.weight).toBe(0.7);
            expect(ConservativeScheme.metrics.nip05Valid?.weight).toBe(0.1);
        });

        it('should have valid progressive scheme', () => {
            expect(ProgressiveScheme.name).toBe('progressive');
            expect(ProgressiveScheme.metrics.distanceWeight?.weight).toBe(0.3);
            expect(ProgressiveScheme.metrics.nip05Valid?.weight).toBe(0.25);
        });

        it('should have valid balanced scheme', () => {
            expect(BalancedScheme.name).toBe('balanced');
            expect(BalancedScheme.metrics.distanceWeight?.weight).toBe(0.2);
            expect(BalancedScheme.metrics.nip05Valid?.weight).toBe(0.2);
        });

        it('should have valid validation-focused scheme', () => {
            expect(ValidationFocusedScheme.name).toBe('validation-focused');
            expect(ValidationFocusedScheme.metrics.nip05Valid?.exponent).toBe(1.2);
            expect(ValidationFocusedScheme.metrics.lightningAddress?.exponent).toBe(1.1);
        });

        it('should have valid social-proof scheme', () => {
            expect(SocialProofScheme.name).toBe('social-proof');
            expect(SocialProofScheme.metrics.distanceWeight?.exponent).toBe(0.8);
            expect(SocialProofScheme.metrics.reciprocity?.exponent).toBe(1.3);
        });
    });

    describe('getWeightingScheme', () => {
        it('should return correct scheme by name', () => {
            const scheme = getWeightingScheme('default');
            expect(scheme.name).toBe('default');
            expect(scheme.version).toBe('v1');
        });

        it('should be case insensitive', () => {
            const scheme = getWeightingScheme('CONSERVATIVE');
            expect(scheme.name).toBe('conservative');
        });

        it('should throw error for unknown scheme', () => {
            expect(() => getWeightingScheme('unknown')).toThrow('Unknown weighting scheme: unknown');
        });
    });

    describe('createCustomScheme', () => {
        it('should create custom scheme with provided metrics', () => {
            const customScheme = createCustomScheme('test', {
                distanceWeight: { weight: 0.6, exponent: 1.0 },
                nip05Valid: { weight: 0.4, exponent: 1.5 },
            });

            expect(customScheme.name).toBe('test');
            expect(customScheme.version).toBe('custom');
            expect(customScheme.metrics.distanceWeight?.weight).toBe(0.6);
            expect(customScheme.metrics.nip05Valid?.exponent).toBe(1.5);
        });

        it('should use defaults for missing properties', () => {
            const customScheme = createCustomScheme('test', {
                distanceWeight: { weight: 0.6 },
                nip05Valid: { exponent: 1.5 },
            });

            expect(customScheme.metrics.distanceWeight?.exponent).toBe(1.0);
            expect(customScheme.metrics.distanceWeight?.enabled).toBe(true);
            expect(customScheme.metrics.nip05Valid?.weight).toBe(0.2);
            expect(customScheme.metrics.nip05Valid?.enabled).toBe(true);
        });
    });

    describe('normalizeWeights', () => {
        it('should normalize weights to sum to 1.0', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 2, exponent: 1.0, enabled: true },
                    nip05Valid: { weight: 1, exponent: 1.0, enabled: true },
                },
            };

            const normalized = normalizeWeights(scheme);
            expect(normalized.metrics.distanceWeight?.weight).toBe(2/3);
            expect(normalized.metrics.nip05Valid?.weight).toBe(1/3);
        });

        it('should not normalize disabled metrics', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 2, exponent: 1.0, enabled: true },
                    nip05Valid: { weight: 1, exponent: 1.0, enabled: false },
                },
            };

            const normalized = normalizeWeights(scheme);
            expect(normalized.metrics.distanceWeight?.weight).toBe(1);
            expect(normalized.metrics.nip05Valid?.weight).toBe(1);
        });

        it('should handle zero total weight', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0, exponent: 1.0, enabled: false },
                    nip05Valid: { weight: 0, exponent: 1.0, enabled: false },
                },
            };

            const normalized = normalizeWeights(scheme);
            expect(normalized.metrics.distanceWeight?.weight).toBe(0);
            expect(normalized.metrics.nip05Valid?.weight).toBe(0);
        });
    });

    describe('validateWeightingScheme', () => {
        it('should validate correct scheme', () => {
            const errors = validateWeightingScheme(DefaultWeightingScheme);
            expect(errors).toHaveLength(0);
        });

        it('should detect empty name', () => {
            const scheme: WeightingScheme = {
                name: '',
                version: 'v1',
                metrics: DefaultWeightingScheme.metrics,
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Weighting scheme must have a name');
        });

        it('should detect empty version', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: '',
                metrics: DefaultWeightingScheme.metrics,
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Weighting scheme must have a version');
        });

        it('should detect no metrics', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {},
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Weighting scheme must have at least one metric');
        });

        it('should detect negative weight', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: -0.5, exponent: 1.0, enabled: true },
                },
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Metric distanceWeight has negative weight -0.5');
        });

        it('should detect invalid exponent', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 0.5, enabled: true },
                },
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Metric distanceWeight has invalid exponent 0.5 (must be ≥ 1)');
        });

        it('should detect positive weight but disabled metric', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: false },
                },
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('Metric distanceWeight has positive weight but is disabled');
        });

        it('should detect no enabled metrics', () => {
            const scheme: WeightingScheme = {
                name: 'test',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0, exponent: 1.0, enabled: false },
                    nip05Valid: { weight: 0, exponent: 1.0, enabled: false },
                },
            };

            const errors = validateWeightingScheme(scheme);
            expect(errors).toContain('At least one metric must be enabled');
        });
    });

    describe('getWeightingSchemeMetadata', () => {
        it('should return metadata for default scheme', () => {
            const metadata = getWeightingSchemeMetadata(DefaultWeightingScheme);
            expect(metadata.name).toBe('default');
            expect(metadata.version).toBe('v1');
            expect(metadata.description).toContain('Balanced scheme');
            expect(metadata.author).toBe('Relatr Team');
            expect(metadata.isDefault).toBe(true);
        });

        it('should return metadata for custom scheme', () => {
            const customScheme = createCustomScheme('custom-test', {
                distanceWeight: { weight: 0.5 },
            });

            const metadata = getWeightingSchemeMetadata(customScheme);
            expect(metadata.name).toBe('custom-test');
            expect(metadata.description).toBe('Custom weighting scheme');
            expect(metadata.isDefault).toBe(false);
        });
    });

    describe('getAllWeightingSchemes', () => {
        it('should return all predefined schemes', () => {
            const schemes = getAllWeightingSchemes();
            expect(schemes).toHaveLength(6);
            
            const names = schemes.map(s => s.name);
            expect(names).toContain('default');
            expect(names).toContain('conservative');
            expect(names).toContain('progressive');
            expect(names).toContain('balanced');
            expect(names).toContain('validation-focused');
            expect(names).toContain('social-proof');
        });
    });

    describe('getWeightingSchemeNames', () => {
        it('should return all scheme names', () => {
            const names = getWeightingSchemeNames();
            expect(names).toHaveLength(6);
            expect(names).toContain('default');
            expect(names).toContain('conservative');
        });
    });

    describe('compareWeightingSchemes', () => {
        it('should detect added metrics', () => {
            const scheme1: WeightingScheme = {
                name: 'test1',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: true },
                },
            };

            const scheme2: WeightingScheme = {
                name: 'test2',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: true },
                    nip05Valid: { weight: 0.5, exponent: 1.0, enabled: true },
                },
            };

            const comparison = compareWeightingSchemes(scheme1, scheme2);
            expect(comparison.added).toContain('nip05Valid');
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(0);
        });

        it('should detect removed metrics', () => {
            const scheme1: WeightingScheme = {
                name: 'test1',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: true },
                    nip05Valid: { weight: 0.5, exponent: 1.0, enabled: true },
                },
            };

            const scheme2: WeightingScheme = {
                name: 'test2',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: true },
                },
            };

            const comparison = compareWeightingSchemes(scheme1, scheme2);
            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toContain('nip05Valid');
            expect(comparison.modified).toHaveLength(0);
        });

        it('should detect modified metrics', () => {
            const scheme1: WeightingScheme = {
                name: 'test1',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.5, exponent: 1.0, enabled: true },
                },
            };

            const scheme2: WeightingScheme = {
                name: 'test2',
                version: 'v1',
                metrics: {
                    distanceWeight: { weight: 0.7, exponent: 1.2, enabled: true },
                },
            };

            const comparison = compareWeightingSchemes(scheme1, scheme2);
            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(1);
            
            const modified = comparison.modified[0];
            if (modified) {
                expect(modified.metric).toBe('distanceWeight');
                expect(modified.oldWeight).toBe(0.5);
                expect(modified.newWeight).toBe(0.7);
                expect(modified.oldExponent).toBe(1.0);
                expect(modified.newExponent).toBe(1.2);
            }
        });

        it('should handle identical schemes', () => {
            const comparison = compareWeightingSchemes(DefaultWeightingScheme, DefaultWeightingScheme);
            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(0);
        });
    });
});