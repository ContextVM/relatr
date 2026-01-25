import { describe, test, expect, beforeEach } from "bun:test";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { runPlugin, runPlugins } from "../plugins/EloPluginRunner";
import type { PortablePlugin } from "../plugins/plugin-types";
import { PlanningStore } from "../plugins/PlanningStore";

describe("Elo Plugins - Runner Integration", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;
  let callCount: number;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry);
    callCount = 0;

    registry.register("test.echo", async (args) => {
      callCount++;
      return args;
    });
  });

  test("should execute multi-round plan/then and consume results in next then", async () => {
    const plugin: PortablePlugin = {
      id: "test-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      // Keep this on a single line to match upstream elo plugin-program parsing fixtures.
      content:
        "plan args = {x: 1}, res = do 'test.echo' args in then x = res.x | 0 in if x == 1 then 1.0 else 0.0",
      manifest: {
        name: "plugin_multi_round",
        relatrVersion: "v1",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const context = {
      targetPubkey: "target-1",
      sourcePubkey: "source-1",
    };

    const planningStore = new PlanningStore();
    const result = await runPlugin(
      plugin,
      context,
      executor,
      {
        eloPluginTimeoutMs: 1000,
        capTimeoutMs: 1000,
      },
      planningStore,
    );

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
    expect(planningStore.size).toBe(1);
  });

  test("should treat non-JSON do args as unplannable and bind null", async () => {
    // Use an explicit non-JSON value. Undefined is rejected by jsonBoundary.
    const plugin: PortablePlugin = {
      id: "test-non-json",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content:
        "plan res = do 'test.echo' _.missing in if res == null then 1.0 else 0.0",
      manifest: {
        name: "plugin_non_json",
        relatrVersion: "v1",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
    expect(callCount).toBe(0);
  });

  test("should deduplicate capability calls across plugins (shared PlanningStore)", async () => {
    const plugin1: PortablePlugin = {
      id: "p1",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.echo' {x: 1} in if res.x == 1 then 1.0 else 0.0",
      manifest: {
        name: "p1",
        relatrVersion: "v1",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const plugin2: PortablePlugin = {
      id: "p2",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.echo' {x: 1} in if res.x == 1 then 1.0 else 0.0",
      manifest: {
        name: "p2",
        relatrVersion: "v1",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    await runPlugins([plugin1, plugin2], { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(callCount).toBe(1);
  });
});
