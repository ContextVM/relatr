import { normalizeToPubkey } from "applesauce-core/helpers";
import type { RelatrConfig } from "./types";
import { WeightProfileManager } from "./validators/weight-profiles";
import { z } from "zod";

const GIGI_PUBKEY =
  "6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93";
/**
 * Zod schema for configuration validation
 */
export const RelatrConfigSchema = z.object({
  defaultSourcePubkey: z
    .string()
    .min(1, "DEFAULT_SOURCE_PUBKEY is required")
    .default(GIGI_PUBKEY),
  databasePath: z.string().default("./data/relatr.db"),
  nostrRelays: z
    .array(z.string())
    .min(1, "At least one NOSTR_RELAY is required")
    .default([
      "wss://relay.damus.io",
      "wss://relay.nostr.band",
      "wss://relay.snort.social",
    ]),
  serverSecretKey: z.string().min(1, "SERVER_SECRET_KEY is required"),
  serverRelays: z.array(z.string()).default(["wss://relay.contextvm.org"]),
  decayFactor: z.number().min(0).default(0.1),
  cacheTtlSeconds: z
    .number()
    .positive()
    .default(60 * 60 * 1000 * 48),
  numberOfHops: z.number().int().positive().default(1),
  syncInterval: z
    .number()
    .positive()
    .default(60 * 60 * 1000 * 21),
  cleanupInterval: z
    .number()
    .positive()
    .default(60 * 60 * 1000 * 7),
  validationSyncInterval: z
    .number()
    .positive()
    .default(60 * 60 * 1000 * 3),
});

/**
 * Load configuration from environment variables
 * @returns Complete RelatrConfig object
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): RelatrConfig {
  const configData = {
    defaultSourcePubkey: process.env.DEFAULT_SOURCE_PUBKEY
      ? normalizeToPubkey(process.env.DEFAULT_SOURCE_PUBKEY)
      : undefined,
    databasePath: process.env.DATABASE_PATH,
    nostrRelays: process.env.NOSTR_RELAYS?.split(",").map((relay) =>
      relay.trim(),
    ),
    serverSecretKey: process.env.SERVER_SECRET_KEY,
    serverRelays: process.env.SERVER_RELAYS?.split(",").map((relay) =>
      relay.trim(),
    ),
    decayFactor: process.env.DECAY_FACTOR
      ? parseFloat(process.env.DECAY_FACTOR)
      : undefined,
    cacheTtlSeconds: process.env.CACHE_TTL_SECONDS
      ? parseInt(process.env.CACHE_TTL_SECONDS, 10)
      : undefined,
    numberOfHops: process.env.NUMBER_OF_HOPS
      ? parseInt(process.env.NUMBER_OF_HOPS, 10)
      : undefined,
    syncInterval: process.env.SYNC_INTERVAL
      ? parseInt(process.env.SYNC_INTERVAL, 10)
      : undefined,
    cleanupInterval: process.env.CLEANUP_INTERVAL
      ? parseInt(process.env.CLEANUP_INTERVAL, 10)
      : undefined,
    validationSyncInterval: process.env.VALIDATION_SYNC_INTERVAL
      ? parseInt(process.env.VALIDATION_SYNC_INTERVAL, 10)
      : undefined,
  };

  const result = RelatrConfigSchema.safeParse(configData);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join(".")}: ${err.message}`)
      .join(", ");
    throw new Error(`Configuration validation failed: ${errorMessages}`);
  }

  return result.data;
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
