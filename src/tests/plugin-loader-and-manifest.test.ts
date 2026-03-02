import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { validateManifest } from "@/plugins/parseManifestTags";
import { loadPluginsFromDirectory } from "@/plugins/PortablePluginLoader";

async function makeTempPluginDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "relatr-plugin-test-"));
  const dir = join(base, "plugins");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("Plugin manifest compatibility + loader policies", () => {
  test("validateManifest should accept compatible caret semver ranges", () => {
    const ok = validateManifest({
      name: "sample_plugin",
      relatrVersion: "^0.1.0",
      title: null,
      description: null,
      weight: null,
    });

    expect(ok.valid).toBe(true);
    expect(ok.errors).toHaveLength(0);
  });

  test("validateManifest should reject incompatible semver ranges", () => {
    const bad = validateManifest({
      name: "sample_plugin",
      relatrVersion: "^0.2.0",
      title: null,
      description: null,
      weight: null,
    });

    expect(bad.valid).toBe(false);
    expect(
      bad.errors.some((e) => e.includes("Unsupported relatr-version")),
    ).toBe(true);
  });

  test("loadPluginsFromDirectory should reject kind != 765", async () => {
    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const dir = await makeTempPluginDir();

    const invalidKindEvent = {
      id: "invalid-kind-event-id",
      pubkey: "author-pubkey-1",
      created_at: 1760000000,
      kind: 1,
      tags: [
        ["n", "invalid_kind_plugin"],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan x = 1 in 1.0",
    };

    await writeFile(
      join(dir, "invalid-kind.json"),
      JSON.stringify(invalidKindEvent, null, 2),
      "utf-8",
    );

    const loaded = await loadPluginsFromDirectory(dir);
    expect(loaded).toHaveLength(0);
  });

  test("loadPluginsFromDirectory should keep latest version per pubkey+n", async () => {
    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const dir = await makeTempPluginDir();

    const mkEvent = (id: string, createdAt: number) => ({
      id,
      pubkey: "author-pubkey-1",
      created_at: createdAt,
      kind: 765,
      tags: [
        ["n", "versioned_plugin"],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan x = 1 in 1.0",
    });

    await writeFile(
      join(dir, "old.json"),
      JSON.stringify(mkEvent("event-old", 1760000000), null, 2),
      "utf-8",
    );
    await writeFile(
      join(dir, "new.json"),
      JSON.stringify(mkEvent("event-new", 1760000500), null, 2),
      "utf-8",
    );

    const loaded = await loadPluginsFromDirectory(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("event-new");
  });
});
