import { describe, it, expect, beforeEach } from 'bun:test';
import { DistanceNormalizer } from '../DistanceNormalizer';
import { DecayProfiles, getDecayProfile, getAllDecayProfiles, createCustomProfile, validateDecayProfile, getDecayProfileMetadata, recommendDecayProfile } from '../DecayProfiles';
import type { DistanceNormalizerConfig } from '../types';

describe('DistanceNormalizer', () => {
    let normalizer: DistanceNormalizer;
    
    beforeEach(() => {
        normalizer = new DistanceNormalizer();
    });
    
    describe('constructor', () => {
        it('should create with default configuration', () => {
            const config = normalizer.getConfig();
            expect(config.decayFactor).toBe(0.1);
            expect(config.maxDistance).toBe(1000);
            expect(config.selfWeight).toBe(1.0);
        });
        
        it('should create with custom configuration', () => {
            const customNormalizer = new DistanceNormalizer({
                decayFactor: 0.2,
                maxDistance: 500,
                selfWeight: 0.9,
            });
            
            const config = customNormalizer.getConfig();
            expect(config.decayFactor).toBe(0.2);
            expect(config.maxDistance).toBe(500);
            expect(config.selfWeight).toBe(0.9);
        });
        
        it('should throw on invalid decay factor', () => {
            expect(() => new DistanceNormalizer({ decayFactor: 0 })).toThrow();
            expect(() => new DistanceNormalizer({ decayFactor: -0.1 })).toThrow();
        });
        
        it('should throw on invalid max distance', () => {
            expect(() => new DistanceNormalizer({ maxDistance: 0 })).toThrow();
            expect(() => new DistanceNormalizer({ maxDistance: -100 })).toThrow();
        });
        
        it('should throw on invalid self weight', () => {
            expect(() => new DistanceNormalizer({ selfWeight: -0.1 })).toThrow();
            expect(() => new DistanceNormalizer({ selfWeight: 1.1 })).toThrow();
        });
    });
    
    describe('normalize', () => {
        it('should return 1.0 for distance 0', () => {
            expect(normalizer.normalize(0)).toBe(1.0);
        });
        
        it('should return 1.0 for distance 1', () => {
            expect(normalizer.normalize(1)).toBe(1.0);
        });
        
        it('should apply linear decay correctly', () => {
            expect(normalizer.normalize(2)).toBeCloseTo(0.9, 10);  // 1 - 0.1×1
            expect(normalizer.normalize(3)).toBeCloseTo(0.8, 10);  // 1 - 0.1×2
            expect(normalizer.normalize(5)).toBeCloseTo(0.6, 10);  // 1 - 0.1×4
            expect(normalizer.normalize(10)).toBeCloseTo(0.1, 10); // 1 - 0.1×9
        });
        
        it('should return 0.0 for unreachable distance', () => {
            expect(normalizer.normalize(1000)).toBe(0.0);
            expect(normalizer.normalize(9999)).toBe(0.0);
        });
        
        it('should clamp negative results to 0', () => {
            expect(normalizer.normalize(11)).toBe(0.0);  // 1 - 0.1×10 = 0
            expect(normalizer.normalize(15)).toBe(0.0);  // 1 - 0.1×14 = -0.4
        });
        
        it('should throw on invalid distance', () => {
            expect(() => normalizer.normalize(-1)).toThrow('Invalid distance: -1');
            expect(() => normalizer.normalize(1.5)).toThrow('Invalid distance: 1.5');
            expect(() => normalizer.normalize(NaN)).toThrow();
            expect(() => normalizer.normalize(Infinity)).toThrow();
        });
        
        it('should respect custom self weight', () => {
            const customNormalizer = new DistanceNormalizer({ selfWeight: 0.8 });
            expect(customNormalizer.normalize(0)).toBe(0.8);
        });
        
        it('should respect custom max distance', () => {
            const customNormalizer = new DistanceNormalizer({ maxDistance: 10 });
            expect(customNormalizer.normalize(10)).toBe(0.0);
            expect(customNormalizer.normalize(11)).toBe(0.0);
        });
    });
    
    describe('normalizeWithResult', () => {
        it('should return complete normalization result', () => {
            const result = normalizer.normalizeWithResult(3);
            
            expect(result.distance).toBe(3);
            expect(result.weight).toBe(0.8);
            expect(result.isReachable).toBe(true);
        });
        
        it('should mark unreachable distances correctly', () => {
            const result = normalizer.normalizeWithResult(1000);
            
            expect(result.distance).toBe(1000);
            expect(result.weight).toBe(0.0);
            expect(result.isReachable).toBe(false);
        });
    });
    
    describe('normalizeMany', () => {
        it('should normalize multiple distances', () => {
            const distances = new Map([
                ['alice', 1],
                ['bob', 3],
                ['charlie', 5],
                ['dave', 1000],
            ]);
            
            const weights = normalizer.normalizeMany(distances);
            
            expect(weights.get('alice')).toBe(1.0);
            expect(weights.get('bob')).toBe(0.8);
            expect(weights.get('charlie')).toBe(0.6);
            expect(weights.get('dave')).toBe(0.0);
        });
        
        it('should handle empty map', () => {
            const weights = normalizer.normalizeMany(new Map());
            expect(weights.size).toBe(0);
        });
    });
    
    describe('normalizeManyWithResult', () => {
        it('should normalize multiple distances with full results', () => {
            const distances = new Map([
                ['alice', 1],
                ['bob', 3],
                ['dave', 1000],
            ]);
            
            const results = normalizer.normalizeManyWithResult(distances);
            
            expect(results).toHaveLength(3);
            
            const aliceResult = results.find(r => r.pubkey === 'alice');
            expect(aliceResult?.distance).toBe(1);
            expect(aliceResult?.weight).toBe(1.0);
            expect(aliceResult?.isReachable).toBe(true);
            
            const daveResult = results.find(r => r.pubkey === 'dave');
            expect(daveResult?.distance).toBe(1000);
            expect(daveResult?.weight).toBe(0.0);
            expect(daveResult?.isReachable).toBe(false);
        });
    });
    
    describe('getZeroWeightThreshold', () => {
        it('should calculate correct threshold for default', () => {
            expect(normalizer.getZeroWeightThreshold()).toBe(11);
        });
        
        it('should calculate correct threshold for different decay factors', () => {
            const strictNormalizer = new DistanceNormalizer({ decayFactor: 0.2 });
            expect(strictNormalizer.getZeroWeightThreshold()).toBe(6);
            
            const lenientNormalizer = new DistanceNormalizer({ decayFactor: 0.05 });
            expect(lenientNormalizer.getZeroWeightThreshold()).toBe(21);
        });
    });
    
    describe('getRawWeight', () => {
        it('should return raw weight without clamping', () => {
            expect(normalizer.getRawWeight(0)).toBe(1.0);
            expect(normalizer.getRawWeight(1)).toBe(1.0);
            expect(normalizer.getRawWeight(3)).toBe(0.8);
            expect(normalizer.getRawWeight(15)).toBeCloseTo(-0.4, 10); // Not clamped
            expect(normalizer.getRawWeight(1000)).toBe(0.0);
        });
    });
    
    describe('isReachable', () => {
        it('should determine reachability correctly', () => {
            expect(normalizer.isReachable(0)).toBe(true);
            expect(normalizer.isReachable(1)).toBe(true);
            expect(normalizer.isReachable(10)).toBe(true);
            expect(normalizer.isReachable(999)).toBe(true);
            expect(normalizer.isReachable(1000)).toBe(false);
            expect(normalizer.isReachable(1001)).toBe(false);
            expect(normalizer.isReachable(-1)).toBe(false);
            expect(normalizer.isReachable(1.5)).toBe(false);
        });
    });
    
    describe('updateConfig', () => {
        it('should update configuration', () => {
            normalizer.updateConfig({ decayFactor: 0.2 });
            
            const config = normalizer.getConfig();
            expect(config.decayFactor).toBe(0.2);
            expect(config.maxDistance).toBe(1000); // Unchanged
            expect(config.selfWeight).toBe(1.0);   // Unchanged
        });
        
        it('should validate updated configuration', () => {
            expect(() => normalizer.updateConfig({ decayFactor: 0 })).toThrow();
        });
    });
    
    describe('generateDecayCurve', () => {
        it('should generate decay curve with default max distance', () => {
            const curve = normalizer.generateDecayCurve();
            
            expect(curve).toHaveLength(21); // 0 to 20 inclusive
            expect(curve[0]).toEqual([0, 1.0]);
            expect(curve[1]).toEqual([1, 1.0]);
            expect(curve[2]).toEqual([2, 0.9]);
            expect(curve[10]).toEqual([10, 0.09999999999999998]);
            expect(curve[11]).toEqual([11, 0.0]);
        });
        
        it('should generate decay curve with custom max distance', () => {
            const curve = normalizer.generateDecayCurve(5);
            
            expect(curve).toHaveLength(6); // 0 to 5 inclusive
            expect(curve[0]).toEqual([0, 1.0]);
            expect(curve[5]).toEqual([5, 0.6]);
        });
    });
    
    describe('generateDetailedDecayCurve', () => {
        it('should generate detailed decay curve', () => {
            const curve = normalizer.generateDetailedDecayCurve(3);
            
            expect(curve).toHaveLength(4);
            expect(curve[0]).toEqual({ distance: 0, weight: 1.0 });
            expect(curve[1]).toEqual({ distance: 1, weight: 1.0 });
            expect(curve[2]).toEqual({ distance: 2, weight: 0.9 });
            expect(curve[3]).toEqual({ distance: 3, weight: 0.8 });
        });
    });
    
    describe('getStatistics', () => {
        it('should return correct statistics', () => {
            const stats = normalizer.getStatistics();
            
            expect(stats.zeroWeightThreshold).toBe(11);
            expect(stats.effectiveReach).toBe(11);
            expect(stats.halfWeightDistance).toBe(6);   // 1 + 0.5/0.1 = 6
            expect(stats.quarterWeightDistance).toBe(9); // 1 + 0.75/0.1 = 8.5 -> 9
        });
    });
    
    describe('compare', () => {
        it('should compare two distances', () => {
            const comparison = normalizer.compare(2, 5);
            
            expect(comparison.distance1).toBe(2);
            expect(comparison.distance2).toBe(5);
            expect(comparison.weight1).toBeCloseTo(0.9, 10);
            expect(comparison.weight2).toBeCloseTo(0.6, 10);
            expect(comparison.difference).toBeCloseTo(0.3, 10);
            expect(comparison.ratio).toBeCloseTo(1.5, 2);
        });
        
        it('should handle zero weight in ratio calculation', () => {
            const comparison = normalizer.compare(5, 15);
            
            expect(comparison.weight1).toBe(0.6);
            expect(comparison.weight2).toBe(0.0);
            expect(comparison.ratio).toBe(Infinity);
        });
    });
});

describe('DecayProfiles', () => {
    describe('getDecayProfile', () => {
        it('should return correct profile', () => {
            const profile = getDecayProfile('DEFAULT');
            expect(profile.decayFactor).toBe(0.1);
            expect(profile.maxDistance).toBe(1000);
            expect(profile.selfWeight).toBe(1.0);
        });
        
        it('should return a copy of the profile', () => {
            const profile1 = getDecayProfile('DEFAULT');
            const profile2 = getDecayProfile('DEFAULT');
            
            profile1.decayFactor = 0.2;
            expect(profile2.decayFactor).toBe(0.1); // Unchanged
        });
    });
    
    describe('getAllDecayProfiles', () => {
        it('should return all profiles', () => {
            const profiles = getAllDecayProfiles();
            
            expect(Object.keys(profiles)).toContain('DEFAULT');
            expect(Object.keys(profiles)).toContain('CONSERVATIVE');
            expect(Object.keys(profiles)).toContain('PROGRESSIVE');
            expect(Object.keys(profiles)).toContain('BALANCED');
            expect(Object.keys(profiles)).toContain('STRICT');
            expect(Object.keys(profiles)).toContain('EXTENDED');
            
            expect(profiles.DEFAULT.decayFactor).toBe(0.1);
            expect(profiles.CONSERVATIVE.decayFactor).toBe(0.2);
        });
    });
    
    describe('createCustomProfile', () => {
        it('should create custom profile with default options', () => {
            const profile = createCustomProfile(0.15);
            
            expect(profile.decayFactor).toBe(0.15);
            expect(profile.maxDistance).toBe(1000);
            expect(profile.selfWeight).toBe(1.0);
        });
        
        it('should create custom profile with custom options', () => {
            const profile = createCustomProfile(0.15, {
                maxDistance: 500,
                selfWeight: 0.9,
            });
            
            expect(profile.decayFactor).toBe(0.15);
            expect(profile.maxDistance).toBe(500);
            expect(profile.selfWeight).toBe(0.9);
        });
    });
    
    describe('validateDecayProfile', () => {
        it('should validate correct profile', () => {
            const errors = validateDecayProfile({
                decayFactor: 0.1,
                maxDistance: 1000,
                selfWeight: 1.0,
            });
            
            expect(errors).toHaveLength(0);
        });
        
        it('should detect invalid decay factor', () => {
            const errors = validateDecayProfile({
                decayFactor: 0,
                maxDistance: 1000,
                selfWeight: 1.0,
            });
            
            expect(errors).toContain('decayFactor must be positive, got 0');
        });
        
        it('should detect decay factor > 1', () => {
            const errors = validateDecayProfile({
                decayFactor: 1.5,
                maxDistance: 1000,
                selfWeight: 1.0,
            });
            
            expect(errors).toContain('decayFactor 1.5 > 1 may produce negative weights');
        });
        
        it('should detect invalid max distance', () => {
            const errors = validateDecayProfile({
                decayFactor: 0.1,
                maxDistance: 0,
                selfWeight: 1.0,
            });
            
            expect(errors).toContain('maxDistance must be positive, got 0');
        });
        
        it('should detect invalid self weight', () => {
            const errors = validateDecayProfile({
                decayFactor: 0.1,
                maxDistance: 1000,
                selfWeight: 1.5,
            });
            
            expect(errors).toContain('selfWeight must be in [0,1], got 1.5');
        });
    });
    
    describe('getDecayProfileMetadata', () => {
        it('should return metadata for default profile', () => {
            const metadata = getDecayProfileMetadata('DEFAULT');
            
            expect(metadata.name).toBe('DEFAULT');
            expect(metadata.description).toBe('Standard linear decay with 10% reduction per hop');
            expect(metadata.decayFactor).toBe(0.1);
            expect(metadata.zeroWeightThreshold).toBe(11);
            expect(metadata.characteristics).toContain('Slow decay - good balance of reach and selectivity');
        });
        
        it('should return metadata for strict profile', () => {
            const metadata = getDecayProfileMetadata('STRICT');
            
            expect(metadata.name).toBe('STRICT');
            expect(metadata.decayFactor).toBe(0.3);
            expect(metadata.zeroWeightThreshold).toBe(5); // Math.ceil(1 + 1/0.3) = 5
            expect(metadata.characteristics).toContain('Very fast decay - highly localized trust');
        });
    });
    
    describe('recommendDecayProfile', () => {
        it('should recommend progressive for social', () => {
            expect(recommendDecayProfile('social')).toBe('PROGRESSIVE');
        });
        
        it('should recommend balanced for professional', () => {
            expect(recommendDecayProfile('professional')).toBe('BALANCED');
        });
        
        it('should recommend conservative for security', () => {
            expect(recommendDecayProfile('security')).toBe('CONSERVATIVE');
        });
        
        it('should recommend extended for exploration', () => {
            expect(recommendDecayProfile('exploration')).toBe('EXTENDED');
        });
    });
});

describe('Integration Tests', () => {
    describe('DistanceNormalizer with DecayProfiles', () => {
        it('should work with conservative profile', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.CONSERVATIVE);
            
            expect(normalizer.normalize(2)).toBe(0.8); // 1 - 0.2×1
            expect(normalizer.normalize(6)).toBe(0.0); // 1 - 0.2×5
            expect(normalizer.getZeroWeightThreshold()).toBe(6);
        });
        
        it('should work with progressive profile', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.PROGRESSIVE);
            
            expect(normalizer.normalize(2)).toBe(0.95); // 1 - 0.05×1
            expect(normalizer.normalize(5)).toBe(0.8);  // 1 - 0.05×4
            expect(normalizer.getZeroWeightThreshold()).toBe(21);
        });
        
        it('should work with strict profile', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.STRICT);
            
            expect(normalizer.normalize(2)).toBeCloseTo(0.7, 10); // 1 - 0.3×1
            expect(normalizer.normalize(4)).toBeCloseTo(0.1, 10); // 1 - 0.3×3
            expect(normalizer.getZeroWeightThreshold()).toBe(5);
        });
        
        it('should work with extended profile', () => {
            const normalizer = new DistanceNormalizer(DecayProfiles.EXTENDED);
            
            expect(normalizer.normalize(2)).toBe(0.975); // 1 - 0.025×1
            expect(normalizer.normalize(10)).toBe(0.775); // 1 - 0.025×9
            expect(normalizer.getZeroWeightThreshold()).toBe(41);
        });
    });
    
    describe('Edge Cases', () => {
        it('should handle very small decay factor', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.001 });
            
            expect(normalizer.normalize(100)).toBeCloseTo(0.901, 2);
            expect(normalizer.getZeroWeightThreshold()).toBe(1001);
        });
        
        it('should handle decay factor exactly 1', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 1.0 });
            
            expect(normalizer.normalize(1)).toBe(1.0);
            expect(normalizer.normalize(2)).toBe(0.0);
            expect(normalizer.getZeroWeightThreshold()).toBe(2);
        });
        
        it('should handle maximum distance edge case', () => {
            const normalizer = new DistanceNormalizer({ maxDistance: 1 });
            
            expect(normalizer.normalize(0)).toBe(1.0);
            expect(normalizer.normalize(1)).toBe(1.0);
            expect(normalizer.normalize(2)).toBe(0.0);
        });
        
        it('should handle self weight variations', () => {
            const normalizer = new DistanceNormalizer({ selfWeight: 0.5 });
            
            expect(normalizer.normalize(0)).toBe(0.5);
            expect(normalizer.normalize(1)).toBe(1.0); // Distance 1 always returns 1.0
            expect(normalizer.normalize(2)).toBe(0.9);
        });
    });
    
    describe('Mathematical Precision', () => {
        it('should handle floating point precision correctly', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.3333333333 });
            
            const weight = normalizer.normalize(2);
            expect(weight).toBeCloseTo(0.6666666667, 7);
        });
        
        it('should maintain precision in batch operations', () => {
            const normalizer = new DistanceNormalizer({ decayFactor: 0.1 });
            
            const distances = new Map([
                ['a', 2],
                ['b', 3],
                ['c', 4],
            ]);
            
            const weights = normalizer.normalizeMany(distances);
            
            expect(weights.get('a')).toBe(0.9);
            expect(weights.get('b')).toBe(0.8);
            expect(weights.get('c')).toBe(0.7);
        });
    });
});