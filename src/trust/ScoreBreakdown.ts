import type { 
    MetricBreakdown, 
    ScoreVisualization, 
    TrustScoreResult,
    WeightingScheme 
} from './types';

/**
 * Utility class for generating detailed score breakdowns and visualizations
 */
export class ScoreBreakdown {
    
    /**
     * Generate a detailed breakdown of trust score calculation
     */
    static generateBreakdown(
        inputs: Record<string, number>,
        scheme: WeightingScheme,
        result: TrustScoreResult
    ): {
        summary: {
            finalScore: number;
            totalWeight: number;
            metricsUsed: number;
            metricsAvailable: number;
        };
        metrics: MetricBreakdown[];
        insights: string[];
        recommendations: string[];
    } {
        const breakdown: MetricBreakdown[] = [];
        let totalWeight = 0;
        let metricsUsed = 0;
        const insights: string[] = [];
        const recommendations: string[] = [];
        
        // Calculate total weight for enabled metrics
        for (const [metricName, config] of Object.entries(scheme.metrics)) {
            if (config.enabled) {
                totalWeight += config.weight;
            }
        }
        
        // Calculate contribution for each metric
        for (const [metricName, config] of Object.entries(scheme.metrics)) {
            const value = inputs[metricName];
            
            if (value === undefined || !config.enabled) {
                continue;
            }
            
            metricsUsed++;
            
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
        
        // Sort by contribution
        breakdown.sort((a, b) => b.contribution - a.contribution);
        
        // Generate insights
        this.generateInsights(breakdown, result.score, insights);
        
        // Generate recommendations
        this.generateRecommendations(breakdown, scheme, inputs, recommendations);
        
        return {
            summary: {
                finalScore: result.score,
                totalWeight,
                metricsUsed,
                metricsAvailable: Object.keys(scheme.metrics).length,
            },
            metrics: breakdown,
            insights,
            recommendations,
        };
    }
    
    /**
     * Generate visualization data for charts
     */
    static generateVisualization(breakdown: MetricBreakdown[]): ScoreVisualization {
        const labels = breakdown.map(m => m.metric);
        const values = breakdown.map(m => m.percentageOfTotal);
        const colors = this.generateColors(breakdown.length);
        
        return {
            score: breakdown.reduce((sum, m) => sum + m.normalizedContribution, 0),
            breakdown,
            chartData: {
                labels,
                values,
                colors,
            },
        };
    }
    
    /**
     * Generate text-based breakdown report
     */
    static generateTextReport(
        breakdown: MetricBreakdown[],
        scheme: WeightingScheme,
        result: TrustScoreResult
    ): string {
        const lines: string[] = [];
        
        lines.push('='.repeat(60));
        lines.push('TRUST SCORE BREAKDOWN REPORT');
        lines.push('='.repeat(60));
        lines.push('');
        
        // Summary
        lines.push('SUMMARY:');
        lines.push(`Final Score: ${result.score.toFixed(4)} (${(result.score * 100).toFixed(1)}%)`);
        lines.push(`Computed At: ${new Date(result.computedAt * 1000).toISOString()}`);
        lines.push(`Weighting Scheme: ${scheme.name} v${scheme.version}`);
        lines.push('');
        
        // Metrics breakdown
        lines.push('METRICS BREAKDOWN:');
        lines.push('-'.repeat(60));
        lines.push('Metric'.padEnd(20) + 
                  'Value'.padEnd(10) + 
                  'Weight'.padEnd(10) + 
                  'Exp'.padEnd(6) + 
                  'Transformed'.padEnd(12) + 
                  'Contribution'.padEnd(12) + 
                  '% of Total');
        lines.push('-'.repeat(60));
        
        for (const metric of breakdown) {
            lines.push(
                metric.metric.padEnd(20) +
                metric.value.toFixed(3).padEnd(10) +
                metric.weight.toFixed(3).padEnd(10) +
                metric.exponent.toFixed(1).padEnd(6) +
                metric.transformedValue.toFixed(3).padEnd(12) +
                metric.contribution.toFixed(3).padEnd(12) +
                metric.percentageOfTotal.toFixed(1) + '%'
            );
        }
        
        lines.push('');
        
        // Formula explanation
        lines.push('FORMULA APPLIED:');
        lines.push('Trust Score = Σ(w_i × v_i^p_i) / Σ(w_i)');
        lines.push('Where:');
        lines.push('  w_i = weight of metric i');
        lines.push('  v_i = value of metric i [0,1]');
        lines.push('  p_i = exponent of metric i');
        lines.push('');
        
        // Calculation details
        const weightedSum = breakdown.reduce((sum, m) => sum + m.contribution, 0);
        const totalWeight = breakdown.reduce((sum, m) => sum + m.weight, 0);
        
        lines.push('CALCULATION DETAILS:');
        lines.push(`Weighted Sum: ${weightedSum.toFixed(4)}`);
        lines.push(`Total Weight: ${totalWeight.toFixed(4)}`);
        lines.push(`Final Score: ${weightedSum.toFixed(4)} / ${totalWeight.toFixed(4)} = ${result.score.toFixed(4)}`);
        lines.push('');
        
        return lines.join('\n');
    }
    
    /**
     * Generate CSV export of breakdown data
     */
    static generateCSV(breakdown: MetricBreakdown[]): string {
        const headers = [
            'Metric',
            'Value',
            'Weight',
            'Exponent',
            'Transformed Value',
            'Contribution',
            'Normalized Contribution',
            'Percentage of Total'
        ];
        
        const rows = breakdown.map(metric => [
            metric.metric,
            metric.value.toFixed(6),
            metric.weight.toFixed(6),
            metric.exponent.toFixed(2),
            metric.transformedValue.toFixed(6),
            metric.contribution.toFixed(6),
            metric.normalizedContribution.toFixed(6),
            metric.percentageOfTotal.toFixed(2) + '%'
        ]);
        
        return [headers, ...rows].map(row => row.join(',')).join('\n');
    }
    
    /**
     * Generate JSON export of breakdown data
     */
    static generateJSON(
        breakdown: MetricBreakdown[],
        scheme: WeightingScheme,
        result: TrustScoreResult
    ): string {
        const exportData = {
            metadata: {
                generatedAt: new Date().toISOString(),
                scheme: {
                    name: scheme.name,
                    version: scheme.version,
                },
                finalScore: result.score,
                computedAt: result.computedAt,
            },
            breakdown,
            formula: {
                description: 'Trust Score = Σ(w_i × v_i^p_i) / Σ(w_i)',
                variables: {
                    'w_i': 'weight of metric i',
                    'v_i': 'value of metric i [0,1]',
                    'p_i': 'exponent of metric i',
                },
            },
        };
        
        return JSON.stringify(exportData, null, 2);
    }
    
    /**
     * Compare two trust score breakdowns
     */
    static compareBreakdowns(
        breakdown1: MetricBreakdown[],
        breakdown2: MetricBreakdown[]
    ): {
        added: string[];
        removed: string[];
        modified: Array<{
            metric: string;
            oldContribution: number;
            newContribution: number;
            change: number;
            changePercent: number;
        }>;
        summary: {
            oldScore: number;
            newScore: number;
            change: number;
            changePercent: number;
        };
    } {
        const metrics1 = new Map(breakdown1.map(m => [m.metric, m]));
        const metrics2 = new Map(breakdown2.map(m => [m.metric, m]));
        
        const allMetrics = new Set([...metrics1.keys(), ...metrics2.keys()]);
        
        const added: string[] = [];
        const removed: string[] = [];
        const modified: Array<{
            metric: string;
            oldContribution: number;
            newContribution: number;
            change: number;
            changePercent: number;
        }> = [];
        
        for (const metric of allMetrics) {
            const oldMetric = metrics1.get(metric);
            const newMetric = metrics2.get(metric);
            
            if (!oldMetric && newMetric) {
                added.push(metric);
            } else if (oldMetric && !newMetric) {
                removed.push(metric);
            } else if (oldMetric && newMetric) {
                const change = newMetric.contribution - oldMetric.contribution;
                const changePercent = oldMetric.contribution !== 0 
                    ? (change / oldMetric.contribution) * 100 
                    : 0;
                
                if (Math.abs(change) > 0.001) { // Only include significant changes
                    modified.push({
                        metric,
                        oldContribution: oldMetric.contribution,
                        newContribution: newMetric.contribution,
                        change,
                        changePercent,
                    });
                }
            }
        }
        
        const oldScore = breakdown1.reduce((sum, m) => sum + m.contribution, 0);
        const newScore = breakdown2.reduce((sum, m) => sum + m.contribution, 0);
        const scoreChange = newScore - oldScore;
        const scoreChangePercent = oldScore !== 0 ? (scoreChange / oldScore) * 100 : 0;
        
        return {
            added,
            removed,
            modified: modified.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)),
            summary: {
                oldScore,
                newScore,
                change: scoreChange,
                changePercent: scoreChangePercent,
            },
        };
    }
    
    // Private helper methods
    
    private static generateInsights(breakdown: MetricBreakdown[], score: number, insights: string[]): void {
        // Score level insights
        if (score >= 0.8) {
            insights.push('Excellent trust score (≥80%) - strong profile validation and social connections');
        } else if (score >= 0.6) {
            insights.push('Good trust score (60-79%) - moderate profile validation and/or social connections');
        } else if (score >= 0.4) {
            insights.push('Fair trust score (40-59%) - some validation present but room for improvement');
        } else {
            insights.push('Low trust score (<40%) - limited profile validation or social connections');
        }
        
        // Top contributor insights
        if (breakdown.length > 0) {
            const topMetric = breakdown[0];
            if (topMetric) {
                insights.push(`${topMetric.metric} is the largest contributor (${topMetric.percentageOfTotal.toFixed(1)}%)`);
                
                // Check for high-impact metrics with low values
                if (topMetric.weight > 0.2 && topMetric.value < 0.5) {
                    insights.push(`High-impact metric ${topMetric.metric} has low value (${topMetric.value.toFixed(2)})`);
                }
            }
        }
        
        // Missing metrics insights
        const highWeightMissing = breakdown.filter(m => m.weight > 0.1 && m.value === 0);
        if (highWeightMissing.length > 0) {
            insights.push(`Missing high-weight metrics: ${highWeightMissing.map(m => m.metric).join(', ')}`);
        }
    }
    
    private static generateRecommendations(
        breakdown: MetricBreakdown[],
        scheme: WeightingScheme,
        inputs: Record<string, number>,
        recommendations: string[]
    ): void {
        // Find metrics with high weight but low values
        const improvementOpportunities = breakdown.filter(m => 
            m.weight > 0.15 && m.value < 0.5 && m.value > 0
        );
        
        if (improvementOpportunities.length > 0) {
            recommendations.push(
                `Focus on improving: ${improvementOpportunities.map(m => m.metric).join(', ')}`
            );
        }
        
        // Find completely missing metrics
        const missingMetrics = Object.keys(scheme.metrics).filter(metricName => {
            const metricConfig = scheme.metrics[metricName];
            return metricConfig && metricConfig.enabled && inputs[metricName] === 0;
        });
        
        if (missingMetrics.length > 0) {
            recommendations.push(`Add missing validations: ${missingMetrics.join(', ')}`);
        }
        
        // Distance-specific recommendations
        const distanceMetric = breakdown.find(m => m.metric === 'distanceWeight');
        if (distanceMetric && distanceMetric.value < 0.5) {
            recommendations.push('Build stronger social connections to improve distance metric');
        }
        
        // Validation-specific recommendations
        const validationMetrics = breakdown.filter(m => 
            m.metric !== 'distanceWeight' && m.value < 1
        );
        
        if (validationMetrics.length > 0) {
            recommendations.push('Complete profile validation setup for better trust scores');
        }
    }
    
    private static generateColors(count: number): string[] {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
        ];
        
        return colors.slice(0, count);
    }
}