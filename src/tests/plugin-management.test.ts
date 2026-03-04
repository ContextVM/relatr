import { describe, test, expect } from "bun:test";
import type { PortablePlugin } from "@/plugins/plugin-types";
import { PluginManager } from "@/plugins/PluginManager";
import type { SettingsRepository } from "@/database/repositories/SettingsRepository";
import type { IEloPluginEngine } from "@/plugins/EloPluginEngine";
import type { TrustCalculator } from "@/trust/TrustCalculator";
import type { RelayPool } from "applesauce-relay";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { neventEncode } from "nostr-tools/nip19";
import { Observable } from "rxjs";

function mkPlugin(pubkey: string, name: string, weight: number | null): PortablePlugin {
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

    const engine: Pick<IEloPluginEngine, "getRuntimeState" | "reloadFromPlugins"> = {
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

    await settings.set("plugins.installed.v1", JSON.stringify({ "pk1:a": p1, "pk2:b": p2 }));
    await settings.set("plugins.enabled.v1", JSON.stringify({ "pk1:a": true, "pk2:b": false }));
    await settings.set("plugins.weightOverrides.v1", JSON.stringify({ "pk1:a": 0.7 }));

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

    const engine: Pick<IEloPluginEngine, "getRuntimeState" | "reloadFromPlugins"> = {
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

    const manager = new PluginManager(
      settings,
      engine,
      trust,
      pool as RelayPool,
      ["wss://relay.example"],
    );

    const installResult = await manager.install({ eventId: signed.id });
    expect(installResult.pluginKey).toBe(`${pk}:relay-plugin`);
    expect(installResult.enabled).toBe(false);

    const configureResult = await manager.configure({
      changes: [{ pluginKey: installResult.pluginKey, enabled: true, weightOverride: 0.4 }],
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

    const engine: Pick<IEloPluginEngine, "getRuntimeState" | "reloadFromPlugins"> = {
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

    const manager = new PluginManager(settings, engine, trust, pool as RelayPool, [defaultRelay]);
    const nevent = neventEncode({ id: signed.id, relays: [hintedRelay] });

    await manager.install({ nevent, relays: [explicitRelay] });

    expect(capturedRelays).toEqual([explicitRelay, hintedRelay, defaultRelay]);
  });
});
