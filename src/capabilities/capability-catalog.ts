import { RELATR_CAPABILITY_DEFINITIONS } from "@contextvm/relo";

export interface CapabilityDefinition {
  name: string;
  envVar: string;
  defaultEnabled: boolean;
  description: string;
}

const RUNTIME_CAPABILITY_DEFAULTS: Record<
  string,
  Pick<CapabilityDefinition, "envVar" | "defaultEnabled">
> = {
  "nostr.query": {
    envVar: "ENABLE_CAP_NOSTR_QUERY",
    defaultEnabled: true,
  },
  "graph.stats": {
    envVar: "ENABLE_CAP_GRAPH_STATS",
    defaultEnabled: true,
  },
  "graph.all_pubkeys": {
    envVar: "ENABLE_CAP_GRAPH_ALL_PUBKEYS",
    defaultEnabled: true,
  },
  "graph.pubkey_exists": {
    envVar: "ENABLE_CAP_GRAPH_PUBKEY_EXISTS",
    defaultEnabled: true,
  },
  "graph.is_following": {
    envVar: "ENABLE_CAP_GRAPH_IS_FOLLOWING",
    defaultEnabled: true,
  },
  "graph.are_mutual": {
    envVar: "ENABLE_CAP_GRAPH_ARE_MUTUAL",
    defaultEnabled: true,
  },
  "graph.distance_from_root": {
    envVar: "ENABLE_CAP_GRAPH_DISTANCE_FROM_ROOT",
    defaultEnabled: true,
  },
  "graph.distance_between": {
    envVar: "ENABLE_CAP_GRAPH_DISTANCE_BETWEEN",
    defaultEnabled: true,
  },
  "graph.users_within_distance": {
    envVar: "ENABLE_CAP_GRAPH_USERS_WITHIN_DISTANCE",
    defaultEnabled: true,
  },
  "graph.degree": {
    envVar: "ENABLE_CAP_GRAPH_DEGREE",
    defaultEnabled: true,
  },
  "http.nip05_resolve": {
    envVar: "ENABLE_CAP_HTTP_NIP05_RESOLVE",
    defaultEnabled: true,
  },
};

export const CAPABILITY_CATALOG: CapabilityDefinition[] =
  RELATR_CAPABILITY_DEFINITIONS.map((definition) => {
    const runtimeDefaults = RUNTIME_CAPABILITY_DEFAULTS[definition.name];

    if (!runtimeDefaults) {
      throw new Error(
        `Missing runtime capability defaults for '${definition.name}'`,
      );
    }

    return {
      name: definition.name,
      description: definition.description,
      envVar: runtimeDefaults.envVar,
      defaultEnabled: runtimeDefaults.defaultEnabled,
    };
  });

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
