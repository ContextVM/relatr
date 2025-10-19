import type { MetricWeights, RelatrConfig } from "./types";
import {
  WeightProfileManager,
  type WeightProfile,
} from "./validators/weight-profiles";

/**
 * Load configuration from environment variables
 * @returns Complete RelatrConfig object
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): RelatrConfig {
  const defaultSourcePubkey = process.env.DEFAULT_SOURCE_PUBKEY;
  const graphBinaryPath = process.env.GRAPH_BINARY_PATH;
  const nostrRelays = process.env.NOSTR_RELAYS;
  const serverSecretKey = process.env.SERVER_SECRET_KEY;
  const serverRelays = process.env.SERVER_RELAYS;

  if (!defaultSourcePubkey) {
    throw new Error("DEFAULT_SOURCE_PUBKEY environment variable is required");
  }

  if (!graphBinaryPath) {
    throw new Error("GRAPH_BINARY_PATH environment variable is required");
  }

  if (!nostrRelays) {
    throw new Error("NOSTR_RELAYS environment variable is required");
  }

  if (!serverSecretKey) {
    throw new Error("SERVER_SECRET_KEY environment variable is required");
  }

  return {
    defaultSourcePubkey,
    graphBinaryPath,
    databasePath: process.env.DATABASE_PATH || "./data/relatr.db",
    nostrRelays: nostrRelays.split(",").map((relay) => relay.trim()),
    serverSecretKey,
    serverRelays: serverRelays
      ? serverRelays.split(",").map((relay) => relay.trim())
      : [],
    decayFactor: parseFloat(process.env.DECAY_FACTOR || "0.1"),
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || "3600", 10),
  };
}

/**
 * Create a WeightProfileManager with all preset profiles registered
 * @returns WeightProfileManager instance with all presets
 */
export function createWeightProfileManager(): WeightProfileManager {
  const manager = new WeightProfileManager();

  // Register all preset profiles
  manager.registerProfile({
    name: "default",
    description:
      "Balanced approach favoring social graph (50%) with moderate profile validation",
    distanceWeight: 0.5,
    validatorWeights: new Map([
      ["nip05Valid", 0.15],
      ["lightningAddress", 0.1],
      ["eventKind10002", 0.1],
      ["reciprocity", 0.15],
      ["isRootNip05", 0.05],
    ]),
  });

  manager.registerProfile({
    name: "social",
    description:
      "Heavy emphasis on social graph proximity (70%), trusts the network",
    distanceWeight: 0.7,
    validatorWeights: new Map([
      ["nip05Valid", 0.1],
      ["lightningAddress", 0.05],
      ["eventKind10002", 0.05],
      ["reciprocity", 0.1],
      ["isRootNip05", 0.0],
    ]),
  });

  manager.registerProfile({
    name: "validation",
    description:
      "Heavy emphasis on profile validations (60%), trusts verified identities",
    distanceWeight: 0.25,
    validatorWeights: new Map([
      ["nip05Valid", 0.25],
      ["lightningAddress", 0.2],
      ["eventKind10002", 0.15],
      ["reciprocity", 0.15],
      ["isRootNip05", 0.1],
    ]),
  });

  manager.registerProfile({
    name: "strict",
    description:
      "Balanced but demanding - requires both strong connections AND strong validations",
    distanceWeight: 0.4,
    validatorWeights: new Map([
      ["nip05Valid", 0.25],
      ["lightningAddress", 0.15],
      ["eventKind10002", 0.1],
      ["reciprocity", 0.1],
      ["isRootNip05", 0.05],
    ]),
  });

  // Activate default profile
  manager.activateProfile("default");

  return manager;
}
