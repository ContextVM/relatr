import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateRelatrPluginProgram } from "../../src/index";

type PluginFixture = {
  content: string;
};

function readPluginContent(path: string): string {
  const fixturePath = resolve(import.meta.dir, "../../../", path);
  const fixture = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as PluginFixture;
  return fixture.content;
}

describe("relo fixture-driven validation", () => {
  const validFixtures = [
    "test-plugins/activity_notes.json",
    "test-plugins/nip05_valid.json",
    "test-plugins/reciprocity_mutual.json",
    "test-plugins/root_nip05.json",
  ];

  for (const fixturePath of validFixtures) {
    it(`accepts realistic plugin fixture ${fixturePath}`, () => {
      const result = validateRelatrPluginProgram(
        readPluginContent(fixturePath),
      );

      expect(result.diagnostics).toEqual([]);
      expect(result.program).not.toBeNull();
    });
  }

  it("reports unknown capability mutations on realistic fixtures", () => {
    const source = readPluginContent(
      "test-plugins/reciprocity_mutual.json",
    ).replace("graph.are_mutual", "graph.unknown_mutual");

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /Unknown capability 'graph\.unknown_mutual'/.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports missing required keys on mutated realistic fixtures", () => {
    const source = readPluginContent(
      "test-plugins/reciprocity_mutual.json",
    ).replace("{a: _.sourcePubkey, b: _.targetPubkey}", "{a: _.sourcePubkey}");

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /requires a 'b' field/.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports unsupported extra keys on strict object capabilities", () => {
    const source = readPluginContent(
      "test-plugins/reciprocity_mutual.json",
    ).replace(
      "{a: _.sourcePubkey, b: _.targetPubkey}",
      "{a: _.sourcePubkey, b: _.targetPubkey, extra: true}",
    );

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /does not support an 'extra' field/.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports non-object argument mutations on realistic fixtures", () => {
    const source = readPluginContent(
      "test-plugins/reciprocity_mutual.json",
    ).replace(
      "do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey}",
      "do 'graph.are_mutual' _.sourcePubkey",
    );

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /requires an object literal argument/.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports type errors in mutated realistic fixtures", () => {
    const source = readPluginContent("test-plugins/nip05_valid.json").replace(
      "{nip05: nip05}",
      "{nip05: 123}",
    );

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /http\.nip05_resolve\.nip05 must be a string literal/.test(
          diagnostic.message,
        ),
      ),
    ).toBe(true);
  });
});
