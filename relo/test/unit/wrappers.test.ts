import { describe, expect, it } from "bun:test";

import { parsePluginProgram } from "@contextvm/elo";

import {
  validateRelatrExpressionAst,
  validateRelatrPluginProgram,
} from "../../src/index";

describe("relo validation wrappers", () => {
  it("validates a Relatr plugin without caller-provided capability wiring", () => {
    const source =
      "plan events = do 'nostr.query' {kinds: [1]}, firstEvent = first(events) in firstEvent | null";

    const result = validateRelatrPluginProgram(source);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.rounds.length).toBe(1);
    expect(result.score).toBeDefined();
  });

  it("reports unknown capabilities through the Relatr wrapper", () => {
    const source =
      "plan events = do 'nostr.missing' {kinds: [1]} in events | null";

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.phase === "capability" &&
          /Unknown capability/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports malformed Relatr capability argument objects", () => {
    const source =
      "plan d = do 'graph.distance_between' {sourcePubkey: 1} in d | null";

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /requires a 'targetPubkey' field/i.test(diagnostic.message),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) =>
        /sourcePubkey must be a string literal/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("rejects non-object arguments for object-shaped capabilities", () => {
    const source =
      "plan users = do 'graph.users_within_distance' 2 in users | []";

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /requires an object literal argument/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("reports invalid numeric literals for distance-based capabilities", () => {
    const source =
      "plan users = do 'graph.users_within_distance' {distance: -1} in users | []";

    const result = validateRelatrPluginProgram(source);

    expect(
      result.diagnostics.some((diagnostic) =>
        /distance must be a non-negative number/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it("preserves caller-provided scope for expression validation", () => {
    const program = parsePluginProgram("plan a = 1 in a + b");

    const diagnostics = validateRelatrExpressionAst(program.score, {
      allowedVariables: ["a"],
    });

    expect(
      diagnostics.some((diagnostic) =>
        /Undefined variable: 'b'/.test(diagnostic.message),
      ),
    ).toBe(true);
  });
});
