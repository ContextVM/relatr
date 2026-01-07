/**
 * Constants and types for the pubkey_kv key-value store.
 *
 * This provides a single source of truth for all supported keys
 * and their corresponding value types.
 */

/**
 * All supported keys for the pubkey_kv store.
 * Using `as const` ensures compile-time safety when using these keys.
 */
export const PUBKEY_KV_KEYS = {
  relay_list: "relay_list",
} as const;

/**
 * Union type of all supported keys.
 */
export type PubkeyKvKey = (typeof PUBKEY_KV_KEYS)[keyof typeof PUBKEY_KV_KEYS];

/**
 * Value structure for TA relay list entries.
 * Versioned to allow future extensions while maintaining backward compatibility.
 */
export type RelayListValueV1 = {
  version: 1;
  relays: string[];
};
