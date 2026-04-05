import { readFileSync } from 'fs';
import { resolve } from 'path';

const packageJsonPath = resolve('package.json');
const versionModulePath = resolve('src/version.ts');

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
  version?: string;
};

const expectedVersion = pkg.version;

if (!expectedVersion) {
  throw new Error('package.json is missing a version field');
}

const versionModule = readFileSync(versionModulePath, 'utf-8');
const match = versionModule.match(/export const HOST_VERSION = "([^"]+)";/);
const actualVersion = match?.[1];

if (!actualVersion) {
  throw new Error(`Could not parse HOST_VERSION from ${versionModulePath}`);
}

if (actualVersion !== expectedVersion) {
  console.error(
    `Version drift detected: package.json=${expectedVersion}, src/version.ts=${actualVersion}`,
  );
  process.exit(1);
}

console.log(`Version metadata is in sync: ${expectedVersion}`);
