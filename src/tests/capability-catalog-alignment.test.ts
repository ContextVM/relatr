import { describe, expect, test } from "bun:test";

import {
  RELATR_CAPABILITY_DEFINITIONS,
  getRelatrCapabilityNames,
} from "@contextvm/relo";

import {
  CAPABILITY_CATALOG,
  getAllCapabilityNames,
  getCapabilityDefinition,
  isValidCapabilityName,
} from "../capabilities/capability-catalog";

describe("runtime capability catalog alignment", () => {
  test("matches relo capability names in definition order", () => {
    expect(getAllCapabilityNames()).toEqual(getRelatrCapabilityNames());
    expect(CAPABILITY_CATALOG.map((capability) => capability.name)).toEqual(
      RELATR_CAPABILITY_DEFINITIONS.map((definition) => definition.name),
    );
  });

  test("projects required runtime policy fields for every relo capability", () => {
    expect(CAPABILITY_CATALOG).toHaveLength(
      RELATR_CAPABILITY_DEFINITIONS.length,
    );

    for (const definition of RELATR_CAPABILITY_DEFINITIONS) {
      const runtimeDefinition = getCapabilityDefinition(definition.name);

      expect(runtimeDefinition).toBeDefined();
      expect(runtimeDefinition?.name).toBe(definition.name);
      expect(runtimeDefinition?.description).toBe(definition.description);
      expect(runtimeDefinition?.envVar).toMatch(/^ENABLE_CAP_/);
      expect(typeof runtimeDefinition?.defaultEnabled).toBe("boolean");
      expect(isValidCapabilityName(definition.name)).toBe(true);
    }
  });

  test("rejects unknown capability names outside the shared catalog", () => {
    expect(isValidCapabilityName("unknown.capability")).toBe(false);
    expect(getCapabilityDefinition("unknown.capability")).toBeUndefined();
  });
});
