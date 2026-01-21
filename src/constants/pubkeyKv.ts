/**
 * Constants and types for the pubkey_kv key-value store.
 *
 * This provides a single source of truth for all supported keys
 * and their corresponding value types.
 */

/**
 * Maximum number of relays to publish TA events to
 * Reduces network traffic and connection overhead
 */
export const MAX_PUBLISH_RELAYS = 15;

/**
 * All supported keys for the pubkey_kv store.
 * Using `as const` ensures compile-time safety when using these keys.
 */
export const PUBKEY_KV_KEYS = {
  ta_relays: "ta_relays",
  user_relays: "user_relays",
} as const;

/**
 * Union type of all supported keys.
 */
export type PubkeyKvKey = (typeof PUBKEY_KV_KEYS)[keyof typeof PUBKEY_KV_KEYS];

/**
 * Value structure for TA relay list entries
 */
export type TARelaysValueV1 = {
  version: 1;
  relays: string[];
};

/**
 * Value structure for user relay list entries (inboxes and outboxes from kind 10002).
 * Versioned to allow future extensions while maintaining backward compatibility.
 */
export type UserRelaysValueV1 = {
  version: 1;
  inboxes?: string[];
  outboxes?: string[];
};
