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
        relatrVersion: "^0.1.16",
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
        relatrVersion: "^0.1.16",
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

  test("should treat do-args evaluation exceptions as unplannable and bind null", async () => {
    // Build an args expression that throws at evaluation time by referencing an
    // unbound variable. This should *not* fail the plugin; it should bind null.
    const plugin: PortablePlugin = {
      id: "test-args-throws",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content:
        "plan res = do 'test.echo' {x: not_defined} in if res == null then 1.0 else 0.0",
      manifest: {
        name: "plugin_args_throws",
        relatrVersion: "^0.1.16",
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
        relatrVersion: "^0.1.16",
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
        relatrVersion: "^0.1.16",
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

  test("should deduplicate failing capability calls across plugins (cache null failures)", async () => {
    // This test asserts v1 failure semantics + dedupe:
    // if a capability fails, the host should still treat it as a null value
    // and avoid re-executing the same requestKey within the same evaluation.
    registry.register("test.fail", async () => {
      callCount++;
      throw new Error("boom");
    });

    const plugin1: PortablePlugin = {
      id: "p_fail_1",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.fail' {x: 1} in if res == null then 1.0 else 0.0",
      manifest: {
        name: "p_fail_1",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const plugin2: PortablePlugin = {
      id: "p_fail_2",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.fail' {x: 1} in if res == null then 1.0 else 0.0",
      manifest: {
        name: "p_fail_2",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const planningStore = new PlanningStore();
    const result1 = await runPlugin(
      plugin1,
      { targetPubkey: "t1" },
      executor,
      { eloPluginTimeoutMs: 1000, capTimeoutMs: 1000 },
      planningStore,
    );
    const result2 = await runPlugin(
      plugin2,
      { targetPubkey: "t1" },
      executor,
      { eloPluginTimeoutMs: 1000, capTimeoutMs: 1000 },
      planningStore,
    );

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result1.score).toBe(1.0);
    expect(result2.score).toBe(1.0);

    // If failures are cached as null in the PlanningStore, the handler runs once.
    expect(callCount).toBe(1);
  });

  test("should map timed-out capability execution to null and not crash scoring", async () => {
    registry.register("test.slow", async () => {
      callCount++;
      // Sleep longer than the configured capTimeoutMs
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true };
    });

    const plugin: PortablePlugin = {
      id: "p_timeout",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.slow' {x: 1} in if res == null then 1.0 else 0.0",
      manifest: {
        name: "p_timeout",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
    expect(callCount).toBe(1);
  });

  test("should enforce host policy: maxRoundsPerPlugin", async () => {
    const plugin: PortablePlugin = {
      id: "p_policy_rounds",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: "plan a = 1 in then b = 2 in then c = 3 in a + b + c",
      manifest: {
        name: "p_policy_rounds",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
      maxRoundsPerPlugin: 2,
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
  });

  test("should enforce host policy: maxRequestsPerRound", async () => {
    const plugin: PortablePlugin = {
      id: "p_policy_req_round",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan a = do 'test.echo' {x: 1}, b = do 'test.echo' {x: 2} in 0.0",
      manifest: {
        name: "p_policy_req_round",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
      maxRequestsPerRound: 1,
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
  });

  test("should enforce host policy: maxTotalRequestsPerPlugin", async () => {
    const plugin: PortablePlugin = {
      id: "p_policy_req_total",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan a = do 'test.echo' {x: 1} in then b = do 'test.echo' {x: 2} in 0.0",
      manifest: {
        name: "p_policy_req_total",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
      maxTotalRequestsPerPlugin: 1,
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
  });

  test("should reject do calls in score expression (compute-only score)", async () => {
    const plugin: PortablePlugin = {
      id: "p_do_in_score",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: "plan a = 1 in do 'test.echo' {x: 1}",
      manifest: {
        name: "p_do_in_score",
        relatrVersion: "^0.1.16",
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

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
  });

  test("should reject nested do inside a binding expression with a clear error", async () => {
    const plugin: PortablePlugin = {
      id: "p_nested_do",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan x = if true then do 'test.echo' {x: 1} else null in if x == null then 1.0 else 0.0",
      manifest: {
        name: "p_nested_do",
        relatrVersion: "^0.1.16",
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

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.error).toContain("nested 'do'");
  });

  test("should keep request keys stable across JSON key order (canonicalization)", async () => {
    callCount = 0;

    const plugin1: PortablePlugin = {
      id: "p_key_order_1",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.echo' {a: 1, b: 2} in if res.a == 1 then 1.0 else 0.0",
      manifest: {
        name: "p_key_order_1",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const plugin2: PortablePlugin = {
      id: "p_key_order_2",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan res = do 'test.echo' {b: 2, a: 1} in if res.a == 1 then 1.0 else 0.0",
      manifest: {
        name: "p_key_order_2",
        relatrVersion: "^0.1.16",
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

    // If canonicalization is stable, these should dedupe.
    expect(callCount).toBe(1);
  });

  test("should dedupe identical requests across rounds within a single plugin run", async () => {
    callCount = 0;

    const plugin: PortablePlugin = {
      id: "p_round_dedupe",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan a = do 'test.echo' {x: 1} in then b = do 'test.echo' {x: 1} in if b.x == 1 then 1.0 else 0.0",
      manifest: {
        name: "p_round_dedupe",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const planningStore = new PlanningStore();
    const result = await runPlugin(
      plugin,
      { targetPubkey: "t1" },
      executor,
      { eloPluginTimeoutMs: 1000, capTimeoutMs: 1000 },
      planningStore,
    );

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
    expect(callCount).toBe(1);
  });

  test("should not count unplannable do calls toward host policy request limits", async () => {
    callCount = 0;

    // maxRequestsPerRound = 1. First do is unplannable (non-JSON args) and should
    // not count; second do is plannable and should be executed.
    const plugin: PortablePlugin = {
      id: "p_policy_unplannable_counts",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content:
        "plan a = do 'test.echo' _.missing, b = do 'test.echo' {x: 2} in if a == null and b.x == 2 then 1.0 else 0.0",
      manifest: {
        name: "p_policy_unplannable_counts",
        relatrVersion: "^0.1.16",
        title: null,
        description: null,
        weight: 1.0,
      },
      rawEvent: {} as unknown as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
      maxRequestsPerRound: 1,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
    expect(callCount).toBe(1);
  });

  test("should fail on forward reference within a round", async () => {
    const plugin: PortablePlugin = {
      id: "p_forward_ref",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      // b references a binding declared later in the same round.
      content: "plan b = a, a = 1 in b",
      manifest: {
        name: "p_forward_ref",
        relatrVersion: "^0.1.16",
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

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
  });

  // Note: _.provisioned was a v0-era convention. In v1, provisioned values are
  // accessed directly via binding names (e.g. `res`), and the host does not
  // populate _.provisioned.
});
