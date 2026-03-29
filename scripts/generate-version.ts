import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// Read version from package.json
const packageJsonPath = resolve("package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Generate version module
const versionModule = `// Auto-generated from package.json
export const HOST_VERSION = "${pkg.version}";
`;

// Write to src/version.ts
const outputPath = resolve("src/version.ts");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, versionModule);

console.log(`Generated ${outputPath} with version: ${pkg.version}`);
