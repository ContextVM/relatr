/**
 * Centralized capability catalog
 * Single source of truth for all capability definitions
 */

export interface CapabilityDefinition {
  name: string;
  envVar: string;
  defaultEnabled: boolean;
  description: string;
}

/**
 * Canonical list of all available capabilities
 * This list drives:
 * - Manifest validation (valid cap names)
 * - Environment variable initialization
 * - Default enablement behavior
 */
export const CAPABILITY_CATALOG: CapabilityDefinition[] = [
  {
    name: "nostr.query",
    envVar: "ENABLE_CAP_NOSTR_QUERY",
    defaultEnabled: true,
    description: "Query Nostr relays for events with a filter",
  },
  {
    name: "graph.stats",
    envVar: "ENABLE_CAP_GRAPH_STATS",
    defaultEnabled: true,
    description: "Get comprehensive graph statistics",
  },
  {
    name: "graph.all_pubkeys",
    envVar: "ENABLE_CAP_GRAPH_ALL_PUBKEYS",
    defaultEnabled: true,
    description: "Get all unique pubkeys in the social graph",
  },
  {
    name: "graph.pubkey_exists",
    envVar: "ENABLE_CAP_GRAPH_PUBKEY_EXISTS",
    defaultEnabled: true,
    description: "Check if a pubkey exists in the graph",
  },
  {
    name: "graph.is_following",
    envVar: "ENABLE_CAP_GRAPH_IS_FOLLOWING",
    defaultEnabled: true,
    description: "Check if a direct follow relationship exists",
  },
  {
    name: "graph.are_mutual",
    envVar: "ENABLE_CAP_GRAPH_ARE_MUTUAL",
    defaultEnabled: true,
    description: "Check if two pubkeys mutually follow each other",
  },
  {
    name: "graph.degree",
    envVar: "ENABLE_CAP_GRAPH_DEGREE",
    defaultEnabled: true,
    description: "Get the degree (number of follows) for a pubkey",
  },
  {
    name: "http.nip05_resolve",
    envVar: "ENABLE_CAP_HTTP_NIP05_RESOLVE",
    defaultEnabled: true,
    description: "Resolve NIP-05 identifier to pubkey",
  },
];

/**
 * Get a capability definition by name
 */
export function getCapabilityDefinition(
  name: string,
): CapabilityDefinition | undefined {
  return CAPABILITY_CATALOG.find((cap) => cap.name === name);
}

/**
 * Check if a capability name is valid (exists in catalog)
 */
export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_CATALOG.some((cap) => cap.name === name);
}

/**
 * Get all valid capability names
 */
export function getAllCapabilityNames(): string[] {
  return CAPABILITY_CATALOG.map((cap) => cap.name);
}
