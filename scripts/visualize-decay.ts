#!/usr/bin/env bun
/**
 * Visualization script for distance decay curves
 *
 * This script generates decay curve data for different profiles and distance ranges,
 * outputting in formats that can be easily plotted or analyzed.
 */

import { DistanceNormalizer } from "../src/distance/DistanceNormalizer";
import {
  DecayProfiles,
  getDecayProfile,
  getAllDecayProfiles,
  getDecayProfileMetadata,
  recommendDecayProfile,
} from "../src/distance/DecayProfiles";
import type { DecayVisualizationData } from "../src/distance/types";

interface VisualizationOptions {
  profiles?: string[];
  maxDistance?: number;
  format?: "table" | "csv" | "json" | "markdown";
  compare?: boolean;
  recommendations?: boolean;
}

/**
 * Generate decay curve data for multiple profiles
 */
function generateVisualizationData(
  options: VisualizationOptions,
): DecayVisualizationData[] {
  const profiles = options.profiles || [
    "DEFAULT",
    "CONSERVATIVE",
    "PROGRESSIVE",
    "BALANCED",
    "STRICT",
    "EXTENDED",
  ];
  const maxDistance = options.maxDistance || 20;

  const data: DecayVisualizationData[] = [];

  for (const profileName of profiles) {
    if (!(profileName in DecayProfiles)) {
      console.warn(`Unknown profile: ${profileName}`);
      continue;
    }

    const config = getDecayProfile(profileName as keyof typeof DecayProfiles);
    const normalizer = new DistanceNormalizer(config);
    const metadata = getDecayProfileMetadata(
      profileName as keyof typeof DecayProfiles,
    );

    const points = normalizer.generateDecayCurve(maxDistance);

    data.push({
      profile: profileName,
      points,
      metadata,
    });
  }

  return data;
}

/**
 * Output data as a formatted table
 */
function outputAsTable(data: DecayVisualizationData[]): void {
  if (data.length === 0) return;

  const maxDistance = Math.max(
    ...data.flatMap((d) => d.points.map((p) => p[0])),
  );

  // Header
  console.log("Distance".padStart(10));
  for (const item of data) {
    console.log(` | ${item.profile.padStart(12)}`);
  }
  console.log("-".repeat(10 + data.length * 15));

  // Data rows
  for (let d = 0; d <= maxDistance; d++) {
    let row = d.toString().padStart(10);

    for (const item of data) {
      const point = item.points.find((p) => p[0] === d);
      const weight = point ? point[1].toFixed(3) : "0.000";
      row += ` | ${weight.padStart(12)}`;
    }

    console.log(row);
  }

  console.log();
}

/**
 * Output data as CSV
 */
function outputAsCSV(data: DecayVisualizationData[]): void {
  if (data.length === 0) return;

  // Header
  console.log("distance," + data.map((d) => d.profile).join(","));

  // Find max distance
  const maxDistance = Math.max(
    ...data.flatMap((d) => d.points.map((p) => p[0])),
  );

  // Data rows
  for (let d = 0; d <= maxDistance; d++) {
    let row = d.toString();

    for (const item of data) {
      const point = item.points.find((p) => p[0] === d);
      const weight = point ? point[1].toFixed(6) : "0.000000";
      row += `,${weight}`;
    }

    console.log(row);
  }
}

/**
 * Output data as JSON
 */
function outputAsJSON(data: DecayVisualizationData[]): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Output data as Markdown table
 */
function outputAsMarkdown(data: DecayVisualizationData[]): void {
  if (data.length === 0) return;

  const maxDistance = Math.max(
    ...data.flatMap((d) => d.points.map((p) => p[0])),
  );

  // Header
  let header = "| Distance";
  let separator = "|----------";

  for (const item of data) {
    header += ` | ${item.profile}`;
    separator += "|------------";
  }
  header += " |";
  separator += "|";

  console.log(header);
  console.log(separator);

  // Data rows
  for (let d = 0; d <= maxDistance; d++) {
    let row = `| ${d.toString().padStart(8)}`;

    for (const item of data) {
      const point = item.points.find((p) => p[0] === d);
      const weight = point ? point[1].toFixed(3) : "0.000";
      row += ` | ${weight.padStart(10)}`;
    }

    row += " |";
    console.log(row);
  }

  console.log();
}

/**
 * Compare profiles side by side
 */
function compareProfiles(): void {
  console.log("=== PROFILE COMPARISON ===\n");

  const allProfiles = getAllDecayProfiles();
  const testDistances = [0, 1, 2, 3, 5, 10, 15];

  console.log("Profile Comparison for Key Distances:\n");

  // Header
  console.log(
    "Profile".padEnd(12) +
      " | α  | Zero | " +
      testDistances.map((d) => `D${d}`).join(" | "),
  );
  console.log(
    "-".repeat(12) +
      "-|----|------|-" +
      testDistances.map(() => "----").join("-+"),
  );

  // Data for each profile
  for (const [profileName, config] of Object.entries(allProfiles)) {
    const normalizer = new DistanceNormalizer(config);
    const zeroThreshold = normalizer.getZeroWeightThreshold();

    let row =
      profileName.padEnd(12) +
      ` | ${config.decayFactor.toFixed(2).padStart(2)} | ${zeroThreshold.toString().padStart(4)} | `;

    for (const distance of testDistances) {
      const weight = normalizer.normalize(distance);
      row += `${weight.toFixed(2).padStart(3)} | `;
    }

    console.log(row);
  }

  console.log();

  // Profile metadata
  console.log("PROFILE METADATA:\n");

  for (const profileName of Object.keys(allProfiles)) {
    const metadata = getDecayProfileMetadata(
      profileName as keyof typeof DecayProfiles,
    );

    console.log(`${metadata.name}:`);
    console.log(`  Description: ${metadata.description}`);
    console.log(`  Decay Factor: ${metadata.decayFactor}`);
    console.log(
      `  Zero Weight Threshold: ${metadata.zeroWeightThreshold} hops`,
    );
    console.log(`  Characteristics: ${metadata.characteristics.join(", ")}`);
    console.log();
  }
}

/**
 * Show profile recommendations
 */
function showRecommendations(): void {
  console.log("=== PROFILE RECOMMENDATIONS ===\n");

  const useCases = [
    "social",
    "professional",
    "security",
    "exploration",
  ] as const;

  for (const useCase of useCases) {
    const recommendation = recommendDecayProfile(useCase);
    const metadata = getDecayProfileMetadata(recommendation);

    console.log(
      `${useCase.charAt(0).toUpperCase() + useCase.slice(1)} networks:`,
    );
    console.log(`  Recommended profile: ${recommendation}`);
    console.log(`  Decay factor: ${metadata.decayFactor}`);
    console.log(`  Reason: ${metadata.description}`);
    console.log();
  }
}

/**
 * Generate sample usage examples
 */
function showUsageExamples(): void {
  console.log("=== USAGE EXAMPLES ===\n");

  // Basic usage
  console.log("// Basic usage with default settings");
  console.log("const normalizer = new DistanceNormalizer();");
  console.log("console.log(normalizer.normalize(3)); // 0.8");
  console.log();

  // Using decay profiles
  console.log("// Using pre-defined decay profiles");
  console.log(
    "const strictNormalizer = new DistanceNormalizer(DecayProfiles.STRICT);",
  );
  console.log("console.log(strictNormalizer.normalize(3)); // 0.4");
  console.log();

  // Custom configuration
  console.log("// Using custom configuration");
  console.log("const customNormalizer = new DistanceNormalizer({");
  console.log("  decayFactor: 0.15,");
  console.log("  maxDistance: 500,");
  console.log("  selfWeight: 0.9");
  console.log("});");
  console.log();

  // Batch normalization
  console.log("// Batch normalization");
  console.log(
    'const distances = new Map([["alice", 1], ["bob", 3], ["charlie", 5]]);',
  );
  console.log("const weights = normalizer.normalizeMany(distances);");
  console.log();

  // Generate decay curve
  console.log("// Generate decay curve for visualization");
  console.log("const curve = normalizer.generateDecayCurve(10);");
  console.log("console.table(curve);");
  console.log();

  // Statistics
  console.log("// Get statistics about the decay profile");
  console.log("const stats = normalizer.getStatistics();");
  console.log(
    "console.log(`Zero weight at: ${stats.zeroWeightThreshold} hops`);",
  );
  console.log();
}

/**
 * Main function
 */
function main(): void {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const options: VisualizationOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--profiles":
        options.profiles = args[++i]?.split(",") || [];
        break;
      case "--max-distance":
        options.maxDistance = parseInt(args[++i]) || 20;
        break;
      case "--format":
        options.format = (args[++i] as any) || "table";
        break;
      case "--compare":
        options.compare = true;
        break;
      case "--recommendations":
        options.recommendations = true;
        break;
      case "--help":
      case "-h":
        console.log(`
Distance Decay Visualization Tool

Usage: bun run visualize-decay.ts [options]

Options:
  --profiles <list>     Comma-separated list of profiles (default: all)
  --max-distance <num>  Maximum distance to generate (default: 20)
  --format <type>       Output format: table, csv, json, markdown (default: table)
  --compare             Show detailed profile comparison
  --recommendations     Show profile recommendations for different use cases
  --help, -h            Show this help message

Examples:
  bun run visualize-decay.ts
  bun run visualize-decay.ts --profiles DEFAULT,STRICT --max-distance 15
  bun run visualize-decay.ts --format csv --max-distance 30
  bun run visualize-decay.ts --compare
  bun run visualize-decay.ts --recommendations
                `);
        return;
    }
  }

  // Show recommendations if requested
  if (options.recommendations) {
    showRecommendations();
    console.log();
  }

  // Show comparison if requested
  if (options.compare) {
    compareProfiles();
    console.log();
  }

  // Generate and display decay curves
  const data = generateVisualizationData(options);

  if (data.length > 0) {
    console.log(
      `=== DECAY CURVES (Max Distance: ${options.maxDistance || 20}) ===\n`,
    );

    switch (options.format) {
      case "csv":
        outputAsCSV(data);
        break;
      case "json":
        outputAsJSON(data);
        break;
      case "markdown":
        outputAsMarkdown(data);
        break;
      case "table":
      default:
        outputAsTable(data);
        break;
    }
  }

  // Show usage examples if no specific options provided
  if (args.length === 0) {
    console.log();
    showUsageExamples();
  }
}

// Run main function if this file is executed directly
if (import.meta.main) {
  main();
}
