import { describe, expect, it } from "bun:test";

import {
  RELATR_PLUGIN_KIND,
  ZERO_PUBKEY,
  buildRelatrManifestTags,
  buildRelatrPluginEvent,
  canonicalizeRelatrPluginEvent,
  classifyRelatrArtifactInput,
  parseRelatrManifestTags,
  stringifyRelatrPluginEvent,
  validateRelatrManifest,
  validateRelatrPluginEvent,
} from "../../src/index";

describe("relo artifact helpers", () => {
  it("builds canonical manifest tags in stable order", () => {
    expect(
      buildRelatrManifestTags({
        name: "activity_notes",
        relatrVersion: "^0.1.16",
        title: "Activity score",
        description: "Scores notes",
        weight: 0.5,
      }),
    ).toEqual([
      ["n", "activity_notes"],
      ["relatr-version", "^0.1.16"],
      ["title", "Activity score"],
      ["description", "Scores notes"],
      ["weight", "0.5"],
    ]);
  });

  it("parses manifest tags from an event", () => {
    expect(
      parseRelatrManifestTags([
        ["title", "Activity score"],
        ["n", "activity_notes"],
        ["relatr-version", "^0.1.16"],
      ]),
    ).toEqual({
      name: "activity_notes",
      relatrVersion: "^0.1.16",
      title: "Activity score",
    });
  });

  it("canonicalizes tag order and enforces a trailing newline", () => {
    const event = canonicalizeRelatrPluginEvent({
      kind: RELATR_PLUGIN_KIND,
      pubkey: ZERO_PUBKEY,
      created_at: 1760000000,
      tags: [
        ["description", "Scores notes"],
        ["n", "activity_notes"],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan\n  value = 0\nin\nvalue",
    });

    expect(event.tags).toEqual([
      ["n", "activity_notes"],
      ["relatr-version", "^0.1.16"],
      ["description", "Scores notes"],
    ]);
    expect(event.content.endsWith("\n")).toBe(true);
  });

  it("classifies raw source and plugin event json input", () => {
    expect(
      classifyRelatrArtifactInput("plan\n  value = 0\nin\nvalue\n"),
    ).toEqual({
      kind: "source",
      source: "plan\n  value = 0\nin\nvalue\n",
    });

    expect(
      classifyRelatrArtifactInput(
        JSON.stringify({
          kind: RELATR_PLUGIN_KIND,
          pubkey: ZERO_PUBKEY,
          created_at: 1760000000,
          tags: [
            ["n", "activity_notes"],
            ["relatr-version", "^0.1.16"],
          ],
          content: "plan\n  value = 0\nin\nvalue\n",
        }),
      ),
    ).toEqual({
      kind: "event",
      event: {
        kind: RELATR_PLUGIN_KIND,
        pubkey: ZERO_PUBKEY,
        created_at: 1760000000,
        tags: [
          ["n", "activity_notes"],
          ["relatr-version", "^0.1.16"],
        ],
        content: "plan\n  value = 0\nin\nvalue\n",
      },
    });
  });

  it("builds and stringifies a plugin event", () => {
    const event = buildRelatrPluginEvent({
      source: "plan\n  value = 0\nin\nvalue\n",
      createdAt: 1760000000,
      manifest: {
        name: "activity_notes",
        relatrVersion: "^0.1.16",
      },
    });

    expect(event).toEqual({
      kind: RELATR_PLUGIN_KIND,
      pubkey: ZERO_PUBKEY,
      created_at: 1760000000,
      tags: [
        ["n", "activity_notes"],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan\n  value = 0\nin\nvalue\n",
    });
    expect(stringifyRelatrPluginEvent(event)).toContain('"kind": 765');
  });

  it("reports manifest validation issues", () => {
    const result = validateRelatrManifest({
      name: "Bad Name",
      relatrVersion: "latest",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "tags.n",
      "tags.relatr-version",
    ]);
  });

  it("validates a built plugin event with source diagnostics", () => {
    const result = validateRelatrPluginEvent({
      kind: RELATR_PLUGIN_KIND,
      pubkey: ZERO_PUBKEY,
      created_at: 1760000000,
      tags: [
        ["n", "activity_notes"],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan value = do 'graph.unknown' {} in value | null\n",
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => /Unknown capability/i.test(issue.message)),
    ).toBe(true);
  });
});
