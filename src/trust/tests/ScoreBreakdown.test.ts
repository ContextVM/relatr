import { describe, it, expect } from 'bun:test';
import { ScoreBreakdown } from '../ScoreBreakdown';
import { DefaultWeightingScheme } from '../WeightingScheme';
import type { TrustScoreResult, WeightingScheme } from '../types';

describe('ScoreBreakdown', () => {
    const testInputs = {
        distanceWeight: 0.8,
        nip05Valid: 1.0,
        lightningAddress: 1.0,
        eventKind10002: 0.0,
        reciprocity: 1.0,
    };

    const testResult: TrustScoreResult = {
        score: 0.8,
        metricValues: testInputs,
        metricWeights: {
            distanceWeight: 0.5,
            nip05Valid: 0.15,
            lightningAddress: 0.1,
            eventKind10002: 0.1,
            reciprocity: 0.15,
        },
        computedAt: Math.floor(Date.now() / 1000),
    };

    describe('generateBreakdown', () => {
        it('should generate detailed breakdown', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            expect(breakdown.summary.finalScore).toBe(0.8);
            expect(breakdown.summary.totalWeight).toBe(1.0);
            expect(breakdown.summary.metricsUsed).toBe(5);
            expect(breakdown.summary.metricsAvailable).toBe(5);
            
            expect(breakdown.metrics).toHaveLength(5);
            expect(breakdown.insights.length).toBeGreaterThan(0);
            expect(breakdown.recommendations.length).toBeGreaterThanOrEqual(0);
        });

        it('should handle partial inputs', () => {
            const partialInputs = {
                distanceWeight: 0.8,
                nip05Valid: 1.0,
                // lightningAddress missing
                // eventKind10002 missing
                // reciprocity missing
            };

            const partialResult: TrustScoreResult = {
                score: 0.475, // (0.8*0.5 + 1.0*0.15) / 0.65
                metricValues: partialInputs,
                metricWeights: {
                    distanceWeight: 0.5,
                    nip05Valid: 0.15,
                },
                computedAt: Math.floor(Date.now() / 1000),
            };

            const breakdown = ScoreBreakdown.generateBreakdown(
                partialInputs,
                DefaultWeightingScheme,
                partialResult
            );

            expect(breakdown.summary.metricsUsed).toBe(2);
            expect(breakdown.summary.metricsAvailable).toBe(5);
            expect(breakdown.metrics).toHaveLength(2);
        });

        it('should generate insights for high scores', () => {
            const highScoreResult: TrustScoreResult = {
                ...testResult,
                score: 0.9,
            };

            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                highScoreResult
            );

            expect(breakdown.insights.some(i => i.includes('Excellent'))).toBe(true);
        });

        it('should generate insights for low scores', () => {
            const lowScoreInputs = {
                distanceWeight: 0.1,
                nip05Valid: 0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };

            const lowScoreResult: TrustScoreResult = {
                score: 0.05,
                metricValues: lowScoreInputs,
                metricWeights: {
                    distanceWeight: 0.5,
                    nip05Valid: 0.15,
                    lightningAddress: 0.1,
                    eventKind10002: 0.1,
                    reciprocity: 0.15,
                },
                computedAt: Math.floor(Date.now() / 1000),
            };

            const breakdown = ScoreBreakdown.generateBreakdown(
                lowScoreInputs,
                DefaultWeightingScheme,
                lowScoreResult
            );

            expect(breakdown.insights.some(i => i.includes('Low'))).toBe(true);
        });

        it('should identify top contributor', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            expect(breakdown.insights.some(i => i.includes('largest contributor'))).toBe(true);
        });

        it('should identify missing high-weight metrics', () => {
            const missingInputs = {
                distanceWeight: 0.8,
                nip05Valid: 0,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };

            const breakdown = ScoreBreakdown.generateBreakdown(
                missingInputs,
                DefaultWeightingScheme,
                testResult
            );

            expect(breakdown.insights.some(i => i.includes('Missing high-weight metrics'))).toBe(true);
        });

        it('should generate recommendations for improvement', () => {
            const partialInputs = {
                distanceWeight: 0.3,
                nip05Valid: 0.5,
                lightningAddress: 0,
                eventKind10002: 0,
                reciprocity: 0,
            };

            const partialResult: TrustScoreResult = {
                score: 0.225,
                metricValues: partialInputs,
                metricWeights: {
                    distanceWeight: 0.5,
                    nip05Valid: 0.15,
                    lightningAddress: 0.1,
                    eventKind10002: 0.1,
                    reciprocity: 0.15,
                },
                computedAt: Math.floor(Date.now() / 1000),
            };

            const breakdown = ScoreBreakdown.generateBreakdown(
                partialInputs,
                DefaultWeightingScheme,
                partialResult
            );

            expect(breakdown.recommendations.length).toBeGreaterThan(0);
        });
    });

    describe('generateVisualization', () => {
        it('should generate visualization data', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const visualization = ScoreBreakdown.generateVisualization(breakdown.metrics);

            expect(visualization.score).toBe(0.8);
            expect(visualization.breakdown).toEqual(breakdown.metrics);
            expect(visualization.chartData.labels).toHaveLength(5);
            expect(visualization.chartData.values).toHaveLength(5);
            expect(visualization.chartData.colors).toHaveLength(5);
        });

        it('should generate colors for different numbers of metrics', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );
            const firstMetric = breakdown.metrics[0];
            if (firstMetric) {
                const singleMetric = [firstMetric];
                const visualization = ScoreBreakdown.generateVisualization(singleMetric);

                expect(visualization.chartData.colors).toHaveLength(1);
                expect(typeof visualization.chartData.colors[0]).toBe('string');
            }
        });
    });

    describe('generateTextReport', () => {
        it('should generate formatted text report', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const report = ScoreBreakdown.generateTextReport(
                breakdown.metrics,
                DefaultWeightingScheme,
                testResult
            );

            expect(report).toContain('TRUST SCORE BREAKDOWN REPORT');
            expect(report).toContain('SUMMARY:');
            expect(report).toContain('Final Score: 0.8000 (80.0%)');
            expect(report).toContain('METRICS BREAKDOWN:');
            expect(report).toContain('FORMULA APPLIED:');
            expect(report).toContain('CALCULATION DETAILS:');
        });

        it('should include all metrics in report', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const report = ScoreBreakdown.generateTextReport(
                breakdown.metrics,
                DefaultWeightingScheme,
                testResult
            );

            expect(report).toContain('distanceWeight');
            expect(report).toContain('nip05Valid');
            expect(report).toContain('lightningAddress');
            expect(report).toContain('eventKind10002');
            expect(report).toContain('reciprocity');
        });

        it('should show correct calculations', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const report = ScoreBreakdown.generateTextReport(
                breakdown.metrics,
                DefaultWeightingScheme,
                testResult
            );

            expect(report).toContain('Weighted Sum: 0.8000');
            expect(report).toContain('Total Weight: 1.0000');
            expect(report).toContain('Final Score: 0.8000 / 1.0000 = 0.8000');
        });
    });

    describe('generateCSV', () => {
        it('should generate CSV format', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const csv = ScoreBreakdown.generateCSV(breakdown.metrics);

            expect(csv).toContain('Metric,Value,Weight,Exponent,Transformed Value,Contribution,Normalized Contribution,Percentage of Total');
            expect(csv).toContain('distanceWeight');
            expect(csv.split('\n')).toHaveLength(6); // Header + 5 metrics
        });

        it('should handle single metric', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );
            const firstMetric = breakdown.metrics[0];
            if (firstMetric) {
                const singleMetric = [firstMetric];
                const csv = ScoreBreakdown.generateCSV(singleMetric);

                expect(csv.split('\n')).toHaveLength(2); // Header + 1 metric
            }
        });
    });

    describe('generateJSON', () => {
        it('should generate JSON format', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const json = ScoreBreakdown.generateJSON(
                breakdown.metrics,
                DefaultWeightingScheme,
                testResult
            );

            const parsed = JSON.parse(json);
            expect(parsed.metadata.scheme.name).toBe('default');
            expect(parsed.metadata.breakdown).toBeDefined();
            if (parsed.metadata.breakdown) {
                expect(parsed.metadata.breakdown).toHaveLength(5);
            }
            expect(parsed.formula.description).toContain('Trust Score');
        });

        it('should include all metadata', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const json = ScoreBreakdown.generateJSON(
                breakdown.metrics,
                DefaultWeightingScheme,
                testResult
            );

            const parsed = JSON.parse(json);
            expect(parsed.metadata.generatedAt).toBeDefined();
            expect(parsed.metadata.finalScore).toBe(0.8);
            expect(parsed.formula.variables).toBeDefined();
        });
    });

    describe('compareBreakdowns', () => {
        it('should detect added metrics', () => {
            const breakdown1 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.4 }
            );

            const breakdown2 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8, nip05Valid: 1.0 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.55 }
            );

            const comparison = ScoreBreakdown.compareBreakdowns(
                breakdown1.metrics,
                breakdown2.metrics
            );

            expect(comparison.added).toContain('nip05Valid');
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(0);
        });

        it('should detect removed metrics', () => {
            const breakdown1 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8, nip05Valid: 1.0 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.55 }
            );

            const breakdown2 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.4 }
            );

            const comparison = ScoreBreakdown.compareBreakdowns(
                breakdown1.metrics,
                breakdown2.metrics
            );

            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toContain('nip05Valid');
            expect(comparison.modified).toHaveLength(0);
        });

        it('should detect modified metrics', () => {
            const breakdown1 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.4 }
            );

            const breakdown2 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.6 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.3 }
            );

            const comparison = ScoreBreakdown.compareBreakdowns(
                breakdown1.metrics,
                breakdown2.metrics
            );

            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(1);
            
            const modified = comparison.modified[0];
            if (modified) {
                expect(modified.metric).toBe('distanceWeight');
                expect(modified.oldContribution).toBe(0.4);
                expect(modified.newContribution).toBe(0.3);
            }
        });

        it('should calculate score changes correctly', () => {
            const breakdown1 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.4 }
            );

            const breakdown2 = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.6 },
                DefaultWeightingScheme,
                { ...testResult, score: 0.3 }
            );

            const comparison = ScoreBreakdown.compareBreakdowns(
                breakdown1.metrics,
                breakdown2.metrics
            );

            expect(comparison.summary.oldScore).toBeCloseTo(0.4, 5);
            expect(comparison.summary.newScore).toBeCloseTo(0.3, 5);
            expect(comparison.summary.change).toBeCloseTo(-0.1, 5);
            expect(comparison.summary.changePercent).toBeCloseTo(-25, 5);
        });

        it('should handle identical breakdowns', () => {
            const breakdown = ScoreBreakdown.generateBreakdown(
                testInputs,
                DefaultWeightingScheme,
                testResult
            );

            const comparison = ScoreBreakdown.compareBreakdowns(
                breakdown.metrics,
                breakdown.metrics
            );

            expect(comparison.added).toHaveLength(0);
            expect(comparison.removed).toHaveLength(0);
            expect(comparison.modified).toHaveLength(0);
            expect(comparison.summary.change).toBe(0);
        });
    });

    describe('Edge cases', () => {
        it('should handle empty breakdown', () => {
            const emptyBreakdown = ScoreBreakdown.generateBreakdown(
                {},
                DefaultWeightingScheme,
                { score: 0, metricValues: {}, metricWeights: {}, computedAt: Date.now() }
            );

            expect(emptyBreakdown.summary.metricsUsed).toBe(0);
            expect(emptyBreakdown.metrics).toHaveLength(0);
        });

        it('should handle single metric breakdown', () => {
            const singleBreakdown = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0.8 },
                DefaultWeightingScheme,
                { score: 0.8, metricValues: { distanceWeight: 0.8 }, metricWeights: { distanceWeight: 1.0 }, computedAt: Date.now() }
            );

            expect(singleBreakdown.summary.metricsUsed).toBe(1);
            expect(singleBreakdown.metrics).toHaveLength(1);
        });

        it('should handle zero score', () => {
            const zeroBreakdown = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 0, nip05Valid: 0 },
                DefaultWeightingScheme,
                { score: 0, metricValues: { distanceWeight: 0, nip05Valid: 0 }, metricWeights: { distanceWeight: 0.5, nip05Valid: 0.5 }, computedAt: Date.now() }
            );

            expect(zeroBreakdown.summary.finalScore).toBe(0);
            expect(zeroBreakdown.insights.some(i => i.includes('Low'))).toBe(true);
        });

        it('should handle perfect score', () => {
            const perfectBreakdown = ScoreBreakdown.generateBreakdown(
                { distanceWeight: 1, nip05Valid: 1 },
                DefaultWeightingScheme,
                { score: 1, metricValues: { distanceWeight: 1, nip05Valid: 1 }, metricWeights: { distanceWeight: 0.5, nip05Valid: 0.5 }, computedAt: Date.now() }
            );

            expect(perfectBreakdown.summary.finalScore).toBe(1);
            expect(perfectBreakdown.insights.some(i => i.includes('Excellent'))).toBe(true);
        });
    });
});