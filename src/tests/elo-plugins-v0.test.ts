import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { parseManifestTags } from "../plugins/parseManifestTags";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { evaluateElo } from "../plugins/EloEvaluator";
import { runPlugin, runPlugins } from "../plugins/EloPluginRunner";
import type { PortablePlugin, EloInput } from "../plugins/plugin-types";
import { PlanningStore } from "../plugins/PlanningStore";

describe("Elo Plugins v0 - Manifest Parsing", () => {
  test("should parse basic manifest tags correctly", () => {
    const tags = [
      ["name", "test_plugin"],
      ["title", "Test Plugin"],
      ["description", "A test plugin"],
      ["weight", "1.5"],
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("test_plugin");
    expect(manifest.title).toBe("Test Plugin");
    expect(manifest.description).toBe("A test plugin");
    expect(manifest.weight).toBe(1.5);
    expect(manifest.caps).toHaveLength(0);
  });

  test("should parse capability tags as allowlist", () => {
    const tags = [
      ["name", "reciprocity_plugin"],
      ["cap", "graph.are_mutual"],
      ["cap", "nostr.query"],
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("reciprocity_plugin");
    expect(manifest.caps).toHaveLength(2);
    expect(manifest.caps).toContain("graph.are_mutual");
    expect(manifest.caps).toContain("nostr.query");
  });

  test("should ignore cap_arg tags", () => {
    const tags = [
      ["name", "test_plugin"],
      ["cap", "graph.are_mutual"],
      ["cap_arg", "some_arg"],
    ];

    const manifest = parseManifestTags(tags);
    expect(manifest.caps).toHaveLength(1);
    expect(manifest.caps[0]).toBe("graph.are_mutual");
  });
});

describe("Elo Plugins v0 - Runner Integration", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;
  let callCount: number;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry);
    callCount = 0;

    // Register test capabilities
    registry.register("test.echo", async (args) => {
      callCount++;
      return args;
    });
    registry.register(
      "test.add",
      async (args) => (args.a || 0) + (args.b || 0),
    );
  });

  test("should plan, provision and score with RELATR blocks", async () => {
    const plugin: PortablePlugin = {
      id: "test-v0-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: `
        --RELATR
        cap echo = test.echo {x: 1}
        cap sum = test.add {a: 10, b: 20}
        --RELATR

        let
          val = fetch(_.provisioned, .echo),
          sum = fetch(_.provisioned, .sum)
        in
        if val.x == 1 and sum == 30 then 1.0 else 0.0
      `,
      manifest: {
        name: "v0_plugin",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.echo", "test.add"],
      },
      rawEvent: {} as any,
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
    expect(planningStore.size).toBe(2);
  });

  test("should deduplicate capability calls across plugins", async () => {
    const plugin1: PortablePlugin = {
      id: "p1",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap echo = test.echo {x: 1}
        --RELATR
        fetch(_.provisioned, .echo)
      `,
      manifest: {
        name: "p1",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.echo"],
      },
      rawEvent: {} as any,
    };

    const plugin2: PortablePlugin = {
      id: "p2",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap echo = test.echo {x: 1}
        --RELATR
        fetch(_.provisioned, .echo)
      `, // Same args
      manifest: {
        name: "p2",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.echo"],
      },
      rawEvent: {} as any,
    };

    const context = { targetPubkey: "t1" };

    await runPlugins([plugin1, plugin2], context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    // Should only be called once due to deduplication in PlanningStore (if we shared it)
    expect(callCount).toBe(1);
  });

  test("should return null for capabilities not in allowlist", async () => {
    const plugin: PortablePlugin = {
      id: "test-allowlist",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap echo = test.echo {x: 1}
        --RELATR
        if fetch(_.provisioned, .echo) == null then 1.0 else 0.0
      `,
      manifest: {
        name: "allowlist_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: [], // Empty allowlist
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0); // cap() returned null
  });

  test("should handle unplannable args_expr", async () => {
    const plugin: PortablePlugin = {
      id: "test-unplannable",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap echo = test.echo undefined_var
        --RELATR
        if fetch(_.provisioned, .echo) == null then 1.0 else 0.0
      `,
      manifest: {
        name: "unplannable_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.echo"],
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0); // cap() returned null
  });

  test("should evaluate args_expr against correct input (_)", async () => {
    // This test verifies that args_expr receives the full Elo input (_)
    // The args_expr is evaluated IN ISOLATION, only referencing _ directly
    const capturedArgs: unknown[] = [];

    registry.register("test.capture", async (args) => {
      capturedArgs.push(args);
      return args;
    });

    // args_expr uses _.targetPubkey directly (not plugin-scoped vars)
    const plugin: PortablePlugin = {
      id: "test-input-convention",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap capture = test.capture {pubkey: _.targetPubkey}
        --RELATR
        fetch(_.provisioned, .capture)
      `,
      manifest: {
        name: "input_convention_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.capture"],
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(
      plugin,
      { targetPubkey: "expected-target" },
      executor,
      { eloPluginTimeoutMs: 1000, capTimeoutMs: 1000 },
    );

    expect(result.success).toBe(true);
    expect(capturedArgs.length).toBe(1);
    // The captured args should be the filter object with pubkey equal to the target
    expect(capturedArgs[0]).toEqual({ pubkey: "expected-target" });
  });

  test("should evaluate args_expr with now in seconds", async () => {
    const capturedArgs: unknown[] = [];

    registry.register("test.time", async (args) => {
      capturedArgs.push(args);
      return args;
    });

    // args_expr uses _.now directly
    const plugin: PortablePlugin = {
      id: "test-now-seconds",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap time = test.time _.now
        --RELATR
        fetch(_.provisioned, .time)
      `,
      manifest: {
        name: "now_seconds_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.time"],
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs.length).toBe(1);
    // now should be in seconds (around 1737568800 for Jan 2025), not milliseconds
    expect(typeof capturedArgs[0]).toBe("number");
    expect(capturedArgs[0]).toBeGreaterThan(1700000000);
    expect(capturedArgs[0]).toBeLessThan(2000000000); // Reasonable upper bound
  });

  test("should handle non-JSON args_expr (e.g. DateTime) as unplannable", async () => {
    // Register a capability that would be called with non-JSON args
    registry.register("test.any", async (args) => args);

    // Elo's DateTime is a non-JSON type - using it in args_expr should make it unplannable
    const plugin: PortablePlugin = {
      id: "test-non-json-args",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      // Using DateTime.now() in args - this is non-JSON
      content: `
        --RELATR
        cap any = test.any DateTime.now()
        --RELATR
        fetch(_.provisioned, .any)
      `,
      manifest: {
        name: "non_json_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.any"],
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    // Should succeed but provisioned id is null (unplannable)
    expect(result.success).toBe(true);
    // fetch(_.provisioned, .any) returns null, which is not a number, so score is 0.0
    expect(result.score).toBe(0.0);
  });

  test("should allow chaining planning via _.planned", async () => {
    const capturedArgs: unknown[] = [];

    registry.register("test.capture", async (args) => {
      capturedArgs.push(args);
      return args;
    });

    const plugin: PortablePlugin = {
      id: "test-planned-chaining",
      pubkey: "pk",
      createdAt: 123,
      kind: 31234,
      content: `
        --RELATR
        cap first = test.capture {x: 1}
        cap second = test.capture {x: fetch(_.planned, .first).x}
        --RELATR
        fetch(_.provisioned, .second)
      `,
      manifest: {
        name: "planned_chaining_test",
        title: null,
        description: null,
        weight: 1.0,
        caps: ["test.capture"],
      },
      rawEvent: {} as any,
    };

    const result = await runPlugin(plugin, { targetPubkey: "t1" }, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    // first + second
    expect(capturedArgs).toEqual([{ x: 1 }, { x: 1 }]);
  });
});
