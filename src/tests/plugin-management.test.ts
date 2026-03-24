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
    let warmupCalls = 0;
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      [],
      dir,
      {
        onValidatorsChanged: () => {
          warmupCalls++;
        },
      },
    );

    await manager.install({ eventId: signed.id, enable: true });
    await Promise.resolve();

    expect(warmupCalls).toBe(1);
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

    let warmupCalls = 0;
    const manager = new PluginManager(
      settings,
      engine,
      trust,
      {} as RelayPool,
      [],
      undefined,
      {
        onValidatorsChanged: () => {
          warmupCalls++;
        },
      },
    );

    await manager.configure({
      changes: [{ pluginKey, weightOverride: 0.7 }],
    });
    await Promise.resolve();
    expect(warmupCalls).toBe(0);

    await manager.configure({
      changes: [{ pluginKey, enabled: true }],
    });
    await Promise.resolve();
    expect(warmupCalls).toBe(1);
  });
});
