import { normalizeToPubkey } from "applesauce-core/helpers";
import type { MetricWeights, RelatrConfig } from "./types";
import { z } from "zod";
import { COMMON_RELAYS, CVM_RELAY } from "./constants/nostr";

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
    .default(COMMON_RELAYS),
  serverSecretKey: z.string().min(1, "SERVER_SECRET_KEY is required"),
  serverRelays: z.array(z.string()).default(CVM_RELAY),
  taExtraRelays: z.array(z.string()).default([]),
  decayFactor: z.number().min(0).default(0.1),
  cacheTtlHours: z.number().positive().default(72),
  numberOfHops: z.number().int().positive().default(1),
  syncIntervalHours: z.number().positive().default(21),
  cleanupIntervalHours: z.number().positive().default(7),
  validationSyncIntervalHours: z.number().positive().default(3),

  // Optional features
  taEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v))
    .default(false),

  // MCP server configuration
  isPublicServer: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v))
    .default(false),
  serverName: z.string().default("Relatr"),
  serverAbout: z
    .string()
    .default(
      "Relatr is a social graph analysis and trust score service for Nostr.",
    ),
  serverWebsite: z.string().default("https://relatr.xyz"),
  serverPicture: z
    .string()
    .default(
      "https://image.nostr.build/30d7fdef1b3d3b83d9e33f47b7d15388deeb47428041f0656612d1450cdb1216.jpg",
    ),
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
    taExtraRelays: process.env.TA_EXTRA_RELAYS?.split(",").map((relay) =>
      relay.trim(),
    ),
    decayFactor: process.env.DECAY_FACTOR
      ? parseFloat(process.env.DECAY_FACTOR)
      : undefined,
    cacheTtlHours: process.env.CACHE_TTL_HOURS
      ? parseInt(process.env.CACHE_TTL_HOURS, 10)
      : undefined,
    numberOfHops: process.env.NUMBER_OF_HOPS
      ? parseInt(process.env.NUMBER_OF_HOPS, 10)
      : undefined,
    syncIntervalHours: process.env.SYNC_INTERVAL_HOURS
      ? parseInt(process.env.SYNC_INTERVAL_HOURS, 10)
      : undefined,
    cleanupIntervalHours: process.env.CLEANUP_INTERVAL_HOURS
      ? parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10)
      : undefined,
    validationSyncIntervalHours: process.env.VALIDATION_SYNC_INTERVAL_HOURS
      ? parseInt(process.env.VALIDATION_SYNC_INTERVAL_HOURS, 10)
      : undefined,

    taEnabled: process.env.TA_ENABLED,

    // MCP server configuration
    isPublicServer: process.env.IS_PUBLIC_SERVER,
    serverName: process.env.SERVER_NAME,
    serverAbout: process.env.SERVER_ABOUT,
    serverWebsite: process.env.SERVER_WEBSITE,
    serverPicture: process.env.SERVER_PICTURE,
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
