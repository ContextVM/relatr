import { describe, test, expect } from "bun:test";
import type { PortablePlugin } from "@/plugins/plugin-types";
import { PluginManager } from "@/plugins/PluginManager";
import type { SettingsRepository } from "@/database/repositories/SettingsRepository";
import type { IEloPluginEngine } from "@/plugins/EloPluginEngine";
import type { TrustCalculator } from "@/trust/TrustCalculator";
import type { RelayPool } from "applesauce-relay";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { neventEncode } from "nostr-tools/nip19";
import { Observable } from "rxjs";
import { resolvePluginWeights } from "@/plugins/resolvePluginWeights";

function mkPlugin(
  pubkey: string,
  name: string,
  weight: number | null,
): PortablePlugin {
  return {
    id: `${pubkey}-${name}-id`,
    pubkey,
    createdAt: 1700000000,
    kind: 765,
    content: "plan x = 1 in 1.0",
    manifest: {
      name,
      relatrVersion: "^0.1.16",
      title: null,
      description: null,
      weight,
    },
    rawEvent: {
      id: `${pubkey}-${name}-id`,
      pubkey,
      created_at: 1700000000,
      kind: 765,
      tags: [
        ["n", name],
        ["relatr-version", "^0.1.16"],
      ],
      content: "plan x = 1 in 1.0",
      sig: "sig",
    },
  };
}

describe("PluginManager v1 list/runtime", () => {
  test("resolvePluginWeights keeps manual overrides pinned and splits the remainder equally", () => {
    const plugins = [
      mkPlugin("pk1", "a", 1 / 3),
      mkPlugin("pk2", "b", 1 / 3),
      mkPlugin("pk3", "c", 1 / 3),
      mkPlugin("pk4", "d", 1 / 3),
    ];

    const resolved = resolvePluginWeights({
      plugins,
      overrides: {
        "pk4:d": 0.25,
      },
    });

    expect(resolved["pk1:a"]).toBeCloseTo(0.25, 6);
    expect(resolved["pk2:b"]).toBeCloseTo(0.25, 6);
    expect(resolved["pk3:c"]).toBeCloseTo(0.25, 6);
    expect(resolved["pk4:d"]).toBeCloseTo(0.25, 6);
  });

  test("resolvePluginWeights normalizes overrides that over-allocate total weight", () => {
    const plugins = [mkPlugin("pk1", "a", null), mkPlugin("pk2", "b", null)];

    const resolved = resolvePluginWeights({
      plugins,
      overrides: {
        "pk1:a": 0.8,
        "pk2:b": 0.4,
      },
    });

    expect(resolved["pk1:a"]).toBeCloseTo(2 / 3, 6);
    expect(resolved["pk2:b"]).toBeCloseTo(1 / 3, 6);
  });

  test("configure can clear an explicit override so the plugin returns to equal remainder splitting", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const plugins = {
      "pk1:a": mkPlugin("pk1", "a", null),
      "pk2:b": mkPlugin("pk2", "b", null),
      "pk3:c": mkPlugin("pk3", "c", null),
      "pk4:d": mkPlugin("pk4", "d", null),
    };

    await settings.set("plugins.installed.v1", JSON.stringify(plugins));
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({
        "pk4:d": 0.25,
      }),
    );

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: Object.values(plugins),
      enabled: {
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      },
      weightOverrides: {
        "pk4:d": 0.25,
      },
      resolvedWeights: {
        "pk1:a": 0.25,
        "pk2:b": 0.25,
        "pk3:c": 0.25,
        "pk4:d": 0.25,
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
    );

    await manager.configure({
      changes: [{ pluginKey: "pk4:d", weightOverride: null }],
    });

    expect(runtime.weightOverrides["pk4:d"]).toBeUndefined();
    expect(runtime.resolvedWeights["pk1:a"]).toBeCloseTo(0.25, 6);
    expect(runtime.resolvedWeights["pk2:b"]).toBeCloseTo(0.25, 6);
    expect(runtime.resolvedWeights["pk3:c"]).toBeCloseTo(0.25, 6);
    expect(runtime.resolvedWeights["pk4:d"]).toBeCloseTo(0.25, 6);
  });

  test("configure redistributes untouched plugins proportionally when one plugin gets a new explicit weight", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const plugins = {
      "pk1:a": mkPlugin("pk1", "a", null),
      "pk2:b": mkPlugin("pk2", "b", null),
      "pk3:c": mkPlugin("pk3", "c", null),
      "pk4:d": mkPlugin("pk4", "d", null),
    };

    await settings.set("plugins.installed.v1", JSON.stringify(plugins));
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({
        "pk2:b": 0.27,
        "pk3:c": 0.25,
        "pk4:d": 0.27,
      }),
    );

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: Object.values(plugins),
      enabled: {
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      },
      weightOverrides: {
        "pk2:b": 0.27,
        "pk3:c": 0.25,
        "pk4:d": 0.27,
      },
      resolvedWeights: {
        "pk1:a": 0.21,
        "pk2:b": 0.27,
        "pk3:c": 0.25,
        "pk4:d": 0.27,
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
    );

    await manager.configure({
      changes: [{ pluginKey: "pk1:a", weightOverride: 0.8 }],
    });

    expect(runtime.weightOverrides["pk1:a"]).toBeCloseTo(0.8, 6);
    expect(runtime.weightOverrides["pk2:b"]).toBeCloseTo(
      0.06835443037974683,
      6,
    );
    expect(runtime.weightOverrides["pk3:c"]).toBeCloseTo(
      0.06329113924050633,
      6,
    );
    expect(runtime.weightOverrides["pk4:d"]).toBeCloseTo(
      0.06835443037974683,
      6,
    );
    expect(runtime.resolvedWeights["pk1:a"]).toBeCloseTo(0.8, 6);
    expect(runtime.resolvedWeights["pk2:b"]).toBeCloseTo(
      0.06835443037974683,
      6,
    );
    expect(runtime.resolvedWeights["pk3:c"]).toBeCloseTo(
      0.06329113924050633,
      6,
    );
    expect(runtime.resolvedWeights["pk4:d"]).toBeCloseTo(
      0.06835443037974683,
      6,
    );
  });

  test("list concise vs verbose contract", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      reloadFromPlugins: async () => {},
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };
    const pool = {} as RelayPool;

    const manager = new PluginManager(settings, engine, trust, pool, []);

    const p1 = mkPlugin("pk1", "a", 0.4);
    const p2 = mkPlugin("pk2", "b", null);

    await settings.set(
      "plugins.installed.v1",
      JSON.stringify({ "pk1:a": p1, "pk2:b": p2 }),
    );
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({ "pk1:a": true, "pk2:b": false }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({ "pk1:a": 0.7 }),
    );

    const concise = await manager.list();
    expect(concise.plugins[0]).toHaveProperty("pluginKey");
    expect(concise.plugins[0]).toHaveProperty("effectiveWeight");
    expect(concise.plugins[0]?.pubkey).toBeUndefined();

    const verbose = await manager.list({ verbose: true });
    expect(verbose.plugins[0]).toHaveProperty("pubkey");
    expect(verbose.plugins[0]).toHaveProperty("versionInfo");
  });

  test("e2e-ish install -> config -> list with relay event fetch", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    let trustWeights: Record<string, number> = {};
    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: (weights) => {
        trustWeights = { ...weights };
      },
    };

    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signed = finalizeEvent(
      {
        kind: 765,
        created_at: 1_700_000_001,
        tags: [
          ["n", "relay-plugin"],
          ["relatr-version", "^0.1.16"],
          ["weight", "0.25"],
          ["title", "Relay plugin"],
        ],
        content: "plan x = 1 in 0.5",
      },
      sk,
    );

    const pool: Pick<RelayPool, "request"> = {
      request: () =>
        new Observable((subscriber) => {
          subscriber.next(signed);
          subscriber.complete();
        }),
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-e2e-"));

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      ["wss://relay.example"],
      dir,
    );

    const installResult = await manager.install({ eventId: signed.id });
    expect(installResult.pluginKey).toBe(`${pk}:relay-plugin`);
    expect(installResult.enabled).toBe(false);

    const configureResult = await manager.configure({
      changes: [
        {
          pluginKey: installResult.pluginKey,
          enabled: true,
          weightOverride: 0.4,
        },
      ],
    });
    expect(configureResult.updated).toBe(1);

    const listed = await manager.list({ verbose: true });
    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]).toEqual(
      expect.objectContaining({
        pluginKey: installResult.pluginKey,
        name: "relay-plugin",
        pubkey: pk,
        enabled: true,
        defaultWeight: 0.25,
        effectiveWeight: 0.4,
      }),
    );

    expect(runtime.enabled[installResult.pluginKey]).toBe(true);
    expect(runtime.weightOverrides[installResult.pluginKey]).toBe(0.4);
    expect(trustWeights[installResult.pluginKey]).toBe(0.4);
  });

  test("install with nevent uses relay hints in request", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      reloadFromPlugins: async () => {},
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const sk = generateSecretKey();
    const signed = finalizeEvent(
      {
        kind: 765,
        created_at: 1_700_000_002,
        tags: [
          ["n", "hint-plugin"],
          ["relatr-version", "^0.1.16"],
        ],
        content: "plan x = 1 in 0.2",
      },
      sk,
    );

    const hintedRelay = "wss://hinted-relay.example";
    const defaultRelay = "wss://default-relay.example";
    const explicitRelay = "wss://explicit-relay.example";
    let capturedRelays: string[] = [];

    const pool: Pick<RelayPool, "request"> = {
      request: (relays) => {
        if (Array.isArray(relays)) {
          capturedRelays = relays;
        }
        return new Observable((subscriber) => {
          subscriber.next(signed);
          subscriber.complete();
        });
      },
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-nevent-"));

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      [defaultRelay],
      dir,
    );
    const nevent = neventEncode({ id: signed.id, relays: [hintedRelay] });

    await manager.install({ nevent, relays: [explicitRelay] });

    expect(capturedRelays).toEqual([explicitRelay, hintedRelay, defaultRelay]);
  });

  test("bootstrapFromFilesystem imports plugins into manager state and runtime", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-management-"));
    const pluginFile = join(dir, "bootstrap.json");
    await writeFile(
      pluginFile,
      JSON.stringify(
        {
          id: "bootstrap-id",
          pubkey: "bootstrap-pubkey",
          created_at: 1_700_000_003,
          kind: 765,
          tags: [
            ["n", "bootstrap_plugin"],
            ["relatr-version", "^0.1.16"],
          ],
          content: "plan x = 1 in 0.2",
          sig: "valid-sig",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const pool = {} as RelayPool;
    const manager = new PluginManager(settings, engine, trust, pool, [], dir);

    const result = await manager.bootstrapFromFilesystem();
    expect(result.imported).toBe(1);

    const listed = await manager.list();
    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]?.pluginKey).toBe(
      "bootstrap-pubkey:bootstrap_plugin",
    );
    expect(listed.plugins[0]?.enabled).toBe(true);

    expect(runtime.plugins).toHaveLength(1);
    expect(runtime.enabled["bootstrap-pubkey:bootstrap_plugin"]).toBe(true);
  });

  test("bootstrapFromFilesystem prunes stale db-installed plugins missing on filesystem", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const stale = mkPlugin("pk-stale", "stale", 0.2);
    const staleKey = "pk-stale:stale";
    await settings.set(
      "plugins.installed.v1",
      JSON.stringify({ [staleKey]: stale }),
    );
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({ [staleKey]: true }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({ [staleKey]: 0.6 }),
    );

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-prune-"));
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      dir,
    );

    await manager.bootstrapFromFilesystem();

    const listed = await manager.list();
    expect(listed.plugins).toHaveLength(0);
    expect(runtime.plugins).toHaveLength(0);
  });

  test("uninstall removes plugins from filesystem and manager state", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
    };
    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };
    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-uninstall-"));
    const p1 = mkPlugin("pk-a", "a", 0.4);
    const p2 = mkPlugin("pk-b", "b", 0.5);
    await writeFile(
      join(dir, "a.json"),
      JSON.stringify(p1.rawEvent, null, 2),
      "utf-8",
    );
    await writeFile(
      join(dir, "b.json"),
      JSON.stringify(p2.rawEvent, null, 2),
      "utf-8",
    );

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      dir,
    );
    await manager.bootstrapFromFilesystem();

    const uninstallResult = await manager.uninstall({
      pluginKeys: ["pk-a:a", "pk-b:b"],
    });
    expect(uninstallResult.removed).toBe(2);

    const listed = await manager.list();
    expect(listed.plugins).toHaveLength(0);
    expect(runtime.plugins).toHaveLength(0);
  });

  test("uninstall redistributes remaining enabled plugin weights back to a total of 1", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const plugins = {
      "pk1:a": mkPlugin("pk1", "a", null),
      "pk2:b": mkPlugin("pk2", "b", null),
      "pk3:c": mkPlugin("pk3", "c", null),
      "pk4:d": mkPlugin("pk4", "d", null),
    };

    const dir = await mkdtemp(
      join(tmpdir(), "relatr-plugin-uninstall-weights-"),
    );
    await writeFile(
      join(dir, "a.json"),
      JSON.stringify(plugins["pk1:a"].rawEvent),
      "utf-8",
    );
    await writeFile(
      join(dir, "b.json"),
      JSON.stringify(plugins["pk2:b"].rawEvent),
      "utf-8",
    );
    await writeFile(
      join(dir, "c.json"),
      JSON.stringify(plugins["pk3:c"].rawEvent),
      "utf-8",
    );
    await writeFile(
      join(dir, "d.json"),
      JSON.stringify(plugins["pk4:d"].rawEvent),
      "utf-8",
    );

    await settings.set("plugins.installed.v1", JSON.stringify(plugins));
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({
        "pk1:a": 0.16,
        "pk2:b": 0.08,
        "pk3:c": 0.16,
      }),
    );

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: Object.values(plugins),
      enabled: {
        "pk1:a": true,
        "pk2:b": true,
        "pk3:c": true,
        "pk4:d": true,
      },
      weightOverrides: {
        "pk1:a": 0.16,
        "pk2:b": 0.08,
        "pk3:c": 0.16,
      },
      resolvedWeights: {
        "pk1:a": 0.16,
        "pk2:b": 0.08,
        "pk3:c": 0.16,
        "pk4:d": 0.6,
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      dir,
    );

    await manager.uninstall({
      pluginKeys: ["pk4:d"],
    });

    expect(runtime.plugins).toHaveLength(3);
    expect(runtime.weightOverrides["pk1:a"]).toBeCloseTo(0.4, 6);
    expect(runtime.weightOverrides["pk2:b"]).toBeCloseTo(0.2, 6);
    expect(runtime.weightOverrides["pk3:c"]).toBeCloseTo(0.4, 6);
    expect(runtime.resolvedWeights["pk1:a"]).toBeCloseTo(0.4, 6);
    expect(runtime.resolvedWeights["pk2:b"]).toBeCloseTo(0.2, 6);
    expect(runtime.resolvedWeights["pk3:c"]).toBeCloseTo(0.4, 6);
    expect(
      Object.values(runtime.resolvedWeights).reduce(
        (sum, weight) => sum + weight,
        0,
      ),
    ).toBeCloseTo(1, 6);
  });

  test("install persists plugin artifact to filesystem", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      reloadFromPlugins: async () => {},
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signed = finalizeEvent(
      {
        kind: 765,
        created_at: 1_700_000_004,
        tags: [
          ["n", "persisted-plugin"],
          ["relatr-version", "^0.1.16"],
        ],
        content: "plan x = 1 in 0.5",
      },
      sk,
    );

    const pool: Pick<RelayPool, "request"> = {
      request: () =>
        new Observable((subscriber) => {
          subscriber.next(signed);
          subscriber.complete();
        }),
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-install-"));
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      [],
      dir,
    );

    const result = await manager.install({ eventId: signed.id, enable: true });
    expect(result.pluginKey).toBe(`${pk}:persisted-plugin`);
    expect(result.enabled).toBe(true);

    const fileName = `${result.pluginKey.replaceAll(":", "-")}.json`;
    const raw = await Bun.file(join(dir, fileName)).text();
    const parsed = JSON.parse(raw) as { id: string; kind: number };
    expect(parsed.id).toBe(signed.id);
    expect(parsed.kind).toBe(765);
  });

  test("install with enable=true triggers non-blocking validator warm-up callback", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => ({
        plugins: [],
        enabled: {},
        weightOverrides: {},
        resolvedWeights: {},
      }),
      reloadFromPlugins: async () => {},
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const sk = generateSecretKey();
    const signed = finalizeEvent(
      {
        kind: 765,
        created_at: 1_700_000_005,
        tags: [
          ["n", "warmup-plugin"],
          ["relatr-version", "^0.1.16"],
        ],
        content: "plan x = 1 in 0.5",
      },
      sk,
    );

    const pool: Pick<RelayPool, "request"> = {
      request: () =>
        new Observable((subscriber) => {
          subscriber.next(signed);
          subscriber.complete();
        }),
    };

    const dir = await mkdtemp(join(tmpdir(), "relatr-plugin-warmup-"));
    const warmupMetricKeys: string[][] = [];
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      [],
      dir,
      {
        onValidatorsChanged: (input) => {
          warmupMetricKeys.push([...(input?.metricKeys ?? [])]);
        },
      },
    );

    await manager.install({ eventId: signed.id, enable: true });
    await Promise.resolve();

    expect(warmupMetricKeys).toEqual([[`${signed.pubkey}:warmup-plugin`]]);
  });

  test("configure triggers validator warm-up only when enabling a plugin", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const plugin = mkPlugin("pk-warm", "warm_config", 0.3);
    const pluginKey = "pk-warm:warm_config";
    await settings.set(
      "plugins.installed.v1",
      JSON.stringify({ [pluginKey]: plugin }),
    );
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({ [pluginKey]: false }),
    );
    await settings.set("plugins.weightOverrides.v1", JSON.stringify({}));

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [],
      enabled: {},
      weightOverrides: {},
      resolvedWeights: {},
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const warmupMetricKeys: string[][] = [];
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      undefined,
      {
        onValidatorsChanged: (input) => {
          warmupMetricKeys.push([...(input?.metricKeys ?? [])]);
        },
      },
    );

    await manager.configure({
      changes: [{ pluginKey, weightOverride: 0.7 }],
    });
    await Promise.resolve();
    expect(warmupMetricKeys).toEqual([]);

    await manager.configure({
      changes: [{ pluginKey, enabled: true }],
    });
    await Promise.resolve();
    expect(warmupMetricKeys).toEqual([[pluginKey]]);
  });

  test("configure does not trigger validator warm-up when only an enabled plugin weight changes", async () => {
    const store = new Map<string, string>();
    const settings: Pick<SettingsRepository, "get" | "set"> = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };

    const plugin = mkPlugin("pk-weight", "weight_scope", 0.3);
    const pluginKey = "pk-weight:weight_scope";
    await settings.set(
      "plugins.installed.v1",
      JSON.stringify({ [pluginKey]: plugin }),
    );
    await settings.set(
      "plugins.enabled.v1",
      JSON.stringify({ [pluginKey]: true }),
    );
    await settings.set(
      "plugins.weightOverrides.v1",
      JSON.stringify({ [pluginKey]: 0.4 }),
    );

    let runtime: ReturnType<IEloPluginEngine["getRuntimeState"]> = {
      plugins: [plugin],
      enabled: { [pluginKey]: true },
      weightOverrides: { [pluginKey]: 0.4 },
      resolvedWeights: { [pluginKey]: 0.4 },
    };

    const engine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    > = {
      getRuntimeState: () => runtime,
      reloadFromPlugins: async (input) => {
        runtime = {
          plugins: [...input.plugins],
          enabled: { ...input.enabled },
          weightOverrides: { ...input.weightOverrides },
          resolvedWeights: { ...input.resolvedWeights },
        };
      },
    };

    const trust: Pick<TrustCalculator, "setPluginWeights"> = {
      setPluginWeights: () => {},
    };

    const warmupMetricKeys: string[][] = [];
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      undefined,
      {
        onValidatorsChanged: (input) => {
          warmupMetricKeys.push([...(input?.metricKeys ?? [])]);
        },
      },
    );

    await manager.configure({
      changes: [{ pluginKey, weightOverride: 0.8 }],
    });
    await Promise.resolve();

    expect(warmupMetricKeys).toEqual([]);
  });
});
