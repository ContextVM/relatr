import { describe, expect, it } from "bun:test";

import {
  RELATR_CAPABILITIES,
  RELATR_CAPABILITY_DEFINITIONS,
  RELATR_VALIDATION_CAPABILITIES,
  getRelatrCapabilityNames,
  isRelatrCapabilityName,
} from "../../src/index";

const EXPECTED_RELATR_CAPABILITY_NAMES = [
  "nostr.query",
  "graph.stats",
  "graph.all_pubkeys",
  "graph.pubkey_exists",
  "graph.is_following",
  "graph.are_mutual",
  "graph.distance_from_root",
  "graph.distance_between",
  "graph.users_within_distance",
  "graph.degree",
  "http.nip05_resolve",
] as const;

describe("relo capability catalog", () => {
  it("exports all capability names in definition order", () => {
    expect(getRelatrCapabilityNames()).toEqual(
      RELATR_CAPABILITY_DEFINITIONS.map((definition) => definition.name),
    );
    expect(getRelatrCapabilityNames()).toEqual([
      ...EXPECTED_RELATR_CAPABILITY_NAMES,
    ]);
  });

  it("exposes validation specs keyed by capability name", () => {
    expect(Object.keys(RELATR_VALIDATION_CAPABILITIES)).toEqual(
      getRelatrCapabilityNames(),
    );

    for (const name of getRelatrCapabilityNames()) {
      expect(RELATR_VALIDATION_CAPABILITIES[name]?.name).toBe(name);

      const definition = RELATR_CAPABILITY_DEFINITIONS.find(
        (capability) => capability.name === name,
      );

      if (definition?.validateArgs) {
        expect(typeof RELATR_VALIDATION_CAPABILITIES[name]?.validateArgs).toBe(
          "function",
        );
      } else {
        expect(
          RELATR_VALIDATION_CAPABILITIES[name]?.validateArgs,
        ).toBeUndefined();
      }
    }
  });

  it("detects known and unknown Relatr capability names", () => {
    expect(isRelatrCapabilityName("nostr.query")).toBe(true);
    expect(isRelatrCapabilityName("graph.distance_between")).toBe(true);
    expect(isRelatrCapabilityName("unknown.capability")).toBe(false);
  });

  it("matches the expected Relatr authoring capability surface", () => {
    expect(getRelatrCapabilityNames()).toEqual([
      ...EXPECTED_RELATR_CAPABILITY_NAMES,
    ]);
  });

  it("exports stable named capability constants for runtime consumers", () => {
    expect(RELATR_CAPABILITIES.nostrQuery).toBe("nostr.query");
    expect(RELATR_CAPABILITIES.graphStats).toBe("graph.stats");
    expect(RELATR_CAPABILITIES.graphAllPubkeys).toBe("graph.all_pubkeys");
    expect(RELATR_CAPABILITIES.graphPubkeyExists).toBe("graph.pubkey_exists");
    expect(RELATR_CAPABILITIES.graphIsFollowing).toBe("graph.is_following");
    expect(RELATR_CAPABILITIES.graphAreMutual).toBe("graph.are_mutual");
    expect(RELATR_CAPABILITIES.graphDistanceFromRoot).toBe(
      "graph.distance_from_root",
    );
    expect(RELATR_CAPABILITIES.graphDistanceBetween).toBe(
      "graph.distance_between",
    );
    expect(RELATR_CAPABILITIES.graphUsersWithinDistance).toBe(
      "graph.users_within_distance",
    );
    expect(RELATR_CAPABILITIES.graphDegree).toBe("graph.degree");
    expect(RELATR_CAPABILITIES.httpNip05Resolve).toBe("http.nip05_resolve");

    expect(Object.values(RELATR_CAPABILITIES)).toEqual([
      ...EXPECTED_RELATR_CAPABILITY_NAMES,
    ]);
  });
});
