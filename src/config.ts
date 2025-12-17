import { normalizeToPubkey } from "applesauce-core/helpers";
import type { MetricWeights, RelatrConfig } from "./types";
import { z } from "zod";

/**
 * Canonical default metric weighting scheme used by trust scoring.
 * Keep this as the single source of truth (tests + runtime).
 */
export const DEFAULT_METRIC_WEIGHTS: MetricWeights = {
  distanceWeight: 0.5,
  validators: {
    nip05Valid: 0.15,
    lightningAddress: 0.1,
    eventKind10002: 0.1,
    reciprocity: 0.1,
    isRootNip05: 0.05,
  },
};

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
    .default(60 * 60 * 1000 * 72),
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

  // Optional features
  taEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v))
    .default(false),
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

    taEnabled: process.env.TA_ENABLED,
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
