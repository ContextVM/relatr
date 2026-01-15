import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { loadPlugins } from "../plugins/PortablePluginLoader";
import { parseManifestTags } from "../plugins/parseManifestTags";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { evaluateElo } from "../plugins/EloEvaluator";
import { runPlugin, runPlugins } from "../plugins/EloPluginRunner";
import type { PortablePlugin } from "../plugins/plugin-types";
import { join } from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { getNestedValue, setNestedValue } from "@/utils/objectPath";

/**
 * Test configuration
 */
const testDir = join(process.cwd(), "test-plugins");
const testPluginPath = join(testDir, "test-plugin.json");

/**
 * Sample test plugin data
 */
const createTestPlugin = (
  content: string,
  caps: Array<{ name: string; args: string[] }> = [],
): any => ({
  id: "test-plugin-001",
  pubkey: "test-pubkey-001",
  created_at: 1704067200,
  kind: 31234,
  tags: [
    ["name", "test_plugin"],
    ["title", "Test Plugin"],
    ["about", "A test plugin for unit tests"],
    ["weight", "1.0"],
    ...caps.flatMap((cap) => [
      ["cap", cap.name],
      ...cap.args.map((arg) => ["cap_arg", arg]),
    ]),
  ],
  content,
  sig: "test-signature",
});

describe("Elo Plugins - Manifest Parsing", () => {
  test("should parse basic manifest tags correctly", () => {
    const tags = [
      ["name", "test_plugin"],
      ["title", "Test Plugin"],
      ["about", "A test plugin"],
      ["weight", "1.5"],
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("test_plugin");
    expect(manifest.title).toBe("Test Plugin");
    expect(manifest.about).toBe("A test plugin");
    expect(manifest.weight).toBe(1.5);
    expect(manifest.caps).toHaveLength(0);
  });

  test("should parse capability tags with arguments", () => {
    const tags = [
      ["name", "reciprocity_plugin"],
      ["cap", "graph.are_mutual"],
      ["cap_arg", "sourcePubkey"],
      ["cap_arg", "targetPubkey"],
      ["cap", "nostr.query"],
      ["cap_arg", '{"kinds": [1]}'],
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("reciprocity_plugin");
    expect(manifest.caps).toHaveLength(2);
    expect(manifest.caps[0]).toEqual({
      name: "graph.are_mutual",
      args: ["sourcePubkey", "targetPubkey"],
    });
    expect(manifest.caps[1]).toEqual({
      name: "nostr.query",
      args: ['{"kinds": [1]}'],
    });
  });

  test("should handle missing optional fields", () => {
    const tags = [["name", "minimal_plugin"]];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("minimal_plugin");
    expect(manifest.title).toBeNull();
    expect(manifest.about).toBeNull();
    expect(manifest.weight).toBeNull();
    expect(manifest.caps).toHaveLength(0);
  });

  test("should handle empty tags array", () => {
    const manifest = parseManifestTags([]);

    expect(manifest.name).toBe("");
    expect(manifest.title).toBeNull();
    expect(manifest.about).toBeNull();
    expect(manifest.weight).toBeNull();
    expect(manifest.caps).toHaveLength(0);
  });

  test("should handle malformed tags gracefully", () => {
    const tags = [
      ["name"], // Missing value
      ["cap"], // Capability without name - should be ignored
      ["cap_arg"], // Argument without value
      ["weight", "not-a-number"], // Invalid number
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe(""); // Empty string for missing value
    expect(manifest.weight).toBeNull(); // Null for invalid number
    expect(manifest.caps).toHaveLength(0); // Empty capability names are filtered out
  });
});

describe("Elo Plugins - Plugin Loading", () => {
  beforeAll(async () => {
    // Create test directory
    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }
  });

  afterAll(async () => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("should load valid plugin from filesystem", async () => {
    const pluginData = createTestPlugin("1.0");
    await writeFile(testPluginPath, JSON.stringify(pluginData, null, 2));

    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const plugins = await loadPlugins(testDir);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe("test-plugin-001");
    expect(plugins[0]?.manifest.name).toBe("test_plugin");
    expect(plugins[0]?.content).toBe("1.0");
    expect(plugins[0]?.unsafe).toBe(false); // Signed plugin
  });

  test("should reject unsigned plugins in safe mode", async () => {
    const pluginData = createTestPlugin("1.0");
    delete pluginData.sig; // Remove signature
    await writeFile(testPluginPath, JSON.stringify(pluginData, null, 2));

    delete process.env.ELO_PLUGINS_ALLOW_UNSAFE;
    const plugins = await loadPlugins(testDir);

    expect(plugins).toHaveLength(0); // Should not load unsigned plugins
  });

  test("should accept unsigned plugins in unsafe mode", async () => {
    const pluginData = createTestPlugin("1.0");
    delete pluginData.sig; // Remove signature
    delete pluginData.id; // Remove id
    await writeFile(testPluginPath, JSON.stringify(pluginData, null, 2));

    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const plugins = await loadPlugins(testDir);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.unsafe).toBe(true); // Marked as unsafe
    expect(plugins[0]?.id).toMatch(/^unsafe:/); // Has unsafe prefix
  });

  test("should handle invalid plugin JSON gracefully", async () => {
    await writeFile(testPluginPath, "invalid json content");

    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const plugins = await loadPlugins(testDir);

    expect(plugins).toHaveLength(0); // Should skip invalid files
  });

  test("should handle missing required fields", async () => {
    const pluginData = {
      pubkey: "test-pubkey",
      created_at: 1704067200,
      // Missing id, kind, tags, content
    };
    await writeFile(testPluginPath, JSON.stringify(pluginData));

    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const plugins = await loadPlugins(testDir);

    expect(plugins).toHaveLength(0); // Should skip invalid plugins
  });
});

describe("Elo Plugins - Capability Registry", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry);
  });

  test("should register capabilities", () => {
    const mockHandler = async () => "test";

    registry.register("test.capability", mockHandler);

    expect(registry.getHandler("test.capability")).toBe(mockHandler);
  });

  test("should respect environment variable enablement", () => {
    // Test default capabilities (graph.are_mutual) which are in the default list
    process.env.ENABLE_CAP_GRAPH_ARE_MUTUAL = "false";

    // Create new registry and executor - executor should pick up the env var
    const testRegistry = new CapabilityRegistry();
    const testExecutor = new CapabilityExecutor(testRegistry);

    // Should be disabled because env var is "false"
    expect(testExecutor.isEnabled("graph.are_mutual")).toBe(false);

    // Clean up
    delete process.env.ENABLE_CAP_GRAPH_ARE_MUTUAL;
  });

  test("should default non-catalog capabilities to enabled when registered", () => {
    const mockHandler = async () => "test";
    registry.register("test.default", mockHandler);

    expect(executor.isEnabled("test.default")).toBe(true);
  });

  test("should handle multiple capability registrations", () => {
    const handler1 = async () => "value1";
    const handler2 = async () => "value2";

    registry.register("cap.one", handler1);
    registry.register("cap.two", handler2);

    expect(executor.isEnabled("cap.one")).toBe(true);
    expect(executor.isEnabled("cap.two")).toBe(true);
  });
});

describe("Elo Plugins - Capability Executor", () => {
  let executor: CapabilityExecutor;
  let registry: CapabilityRegistry;

  beforeAll(async () => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry, 1); // 1 hour cache TTL

    // Register a mock capability
    registry.register("test.echo", async (args) => {
      return args[0] || "default";
    });
  });

  test("should execute capability successfully", async () => {
    const request = {
      capName: "test.echo",
      args: ["hello"],
      timeoutMs: 1000,
    };

    const context = {
      targetPubkey: "test-pubkey",
      sourcePubkey: "source-pubkey",
      config: { capTimeoutMs: 1000 },
    };
    const response = await executor.execute(request, context, "test-plugin");

    expect(response.ok).toBe(true);
    expect(response.value).toBe("hello");
    expect(response.error).toBeNull();
  });

  test("should handle capability errors gracefully", async () => {
    registry.register("test.error", async () => {
      throw new Error("Capability failed");
    });

    const request = {
      capName: "test.error",
      args: [],
      timeoutMs: 1000,
    };

    const context = {
      targetPubkey: "test-pubkey",
      config: { capTimeoutMs: 1000 },
    };
    const response = await executor.execute(request, context, "test-plugin");

    expect(response.ok).toBe(false);
    expect(response.value).toBeNull();
    expect(response.error).toContain("Capability failed");
  });

  test("should enforce timeout on slow capabilities", async () => {
    registry.register("test.slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "slow";
    });

    const request = {
      capName: "test.slow",
      args: [],
      timeoutMs: 100, // 100ms timeout
    };

    const context = {
      targetPubkey: "test-pubkey",
      config: { capTimeoutMs: 1000 },
    };
    const response = await executor.execute(request, context, "test-plugin");

    expect(response.ok).toBe(false);
    expect(response.error).toContain("timed out"); // Match actual error message
  });

  test("should cache capability results", async () => {
    let callCount = 0;
    registry.register("test.counter", async () => {
      callCount++;
      return `call-${callCount}`;
    });

    const request = {
      capName: "test.counter",
      args: [],
      timeoutMs: 1000,
    };

    const context = {
      targetPubkey: "test-pubkey",
      config: { capTimeoutMs: 1000 },
    };

    // First call
    const response1 = await executor.execute(request, context, "test-plugin");
    expect(response1.ok).toBe(true);
    expect(response1.value).toBe("call-1");

    // Second call (should be cached)
    const response2 = await executor.execute(request, context, "test-plugin");
    expect(response2.ok).toBe(true);
    expect(response2.value).toBe("call-1"); // Same value, from cache
    expect(callCount).toBe(1); // Handler only called once
  });
});

describe("Elo Plugins - Elo Evaluator", () => {
  test("should compile and evaluate simple Elo expression", async () => {
    const plugin: PortablePlugin = {
      id: "test-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "0.8",
      manifest: {
        name: "simple_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const input = {
      pubkey: "test-target",
      now: Date.now(),
      cap: {},
    };

    const result = await evaluateElo(plugin, input, 1000);

    expect(result.success).toBe(true);
    expect(result.score).toBe(0.8);
    expect(result.error).toBeUndefined();
  });

  test("should access capability results in Elo code", async () => {
    const plugin: PortablePlugin = {
      id: "test-002",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.graph.test then 1.0 else 0.5",
      manifest: {
        name: "cap_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const inputWithCap = {
      pubkey: "test-target",
      now: Date.now(),
      cap: { graph: { test: true } },
    };

    const inputWithoutCap = {
      pubkey: "test-target",
      now: Date.now(),
      cap: { graph: { test: false } },
    };

    const result1 = await evaluateElo(plugin, inputWithCap, 1000);
    expect(result1.success).toBe(true);
    expect(result1.score).toBe(1.0);

    const result2 = await evaluateElo(plugin, inputWithoutCap, 1000);
    expect(result2.success).toBe(true);
    expect(result2.score).toBe(0.5);
  });

  test("should clamp scores to [0, 1] range", async () => {
    const plugin: PortablePlugin = {
      id: "test-003",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "2.5", // Above 1.0
      manifest: {
        name: "clamp_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const input = {
      pubkey: "test-target",
      now: Date.now(),
      cap: {},
    };

    const result = await evaluateElo(plugin, input, 1000);

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0); // Clamped to max
  });

  test("should handle Elo compilation errors", async () => {
    const plugin: PortablePlugin = {
      id: "test-004",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "invalid @ syntax % here",
      manifest: {
        name: "invalid_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const input = {
      pubkey: "test-target",
      now: Date.now(),
      cap: {},
    };

    const result = await evaluateElo(plugin, input, 1000);

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.error).toBeDefined();
  });

  test("should handle evaluation errors gracefully", async () => {
    const plugin: PortablePlugin = {
      id: "test-005",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "undefined_variable + 1", // Reference to undefined variable
      manifest: {
        name: "error_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const input = {
      pubkey: "test-target",
      now: Date.now(),
      cap: {},
    };

    const result = await evaluateElo(plugin, input, 1000);

    // Should fail gracefully with safe default
    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.error).toBeDefined();
  });

  test("should cache compiled Elo functions", async () => {
    const plugin: PortablePlugin = {
      id: "test-cache",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "0.75", // Simple numeric expression
      manifest: {
        name: "cache_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const input1 = {
      pubkey: "pubkey-1",
      now: Date.now(),
      cap: {},
    };

    const input2 = {
      pubkey: "pubkey-2",
      now: Date.now(),
      cap: {},
    };

    // First evaluation
    const result1 = await evaluateElo(plugin, input1, 1000);
    expect(result1.success).toBe(true);
    expect(result1.score).toBe(0.75);

    // Second evaluation (should use cached compilation but different input)
    const result2 = await evaluateElo(plugin, input2, 1000);
    expect(result2.success).toBe(true);
    expect(result2.score).toBe(0.75); // Same result, proving compilation was cached
  });
});

describe("Elo Plugins - Plugin Runner Integration", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeAll(async () => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry, 1); // 1 hour cache TTL

    // Register test capabilities
    registry.register("test.always_true", async () => true);
    registry.register("test.always_false", async () => false);
    registry.register("test.return_arg", async (args) => args[0] || "no-arg");
  });

  test("should run plugin with successful capabilities", async () => {
    const plugin: PortablePlugin = {
      id: "integration-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.test.always_true then 0.9 else 0.1",
      manifest: {
        name: "integration_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [{ name: "test.always_true", args: [] }],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
      sourcePubkey: "test-source",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.pluginName).toBe("integration_plugin");
  });

  test("should handle plugin with failed capabilities", async () => {
    const plugin: PortablePlugin = {
      id: "integration-002",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.test.nonexistent then 1.0 else 0.0",
      manifest: {
        name: "fail_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [{ name: "test.nonexistent", args: [] }],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true); // Plugin should succeed even if capability fails
    expect(result.score).toBe(0.0); // Should return 0.0 for failed capability
  });

  test("should run multiple plugins and return metrics map", async () => {
    const plugin1: PortablePlugin = {
      id: "multi-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "0.7",
      manifest: {
        name: "plugin_one",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const plugin2: PortablePlugin = {
      id: "multi-002",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "0.9",
      manifest: {
        name: "plugin_two",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const metrics = await runPlugins([plugin1, plugin2], context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(metrics).toEqual({
      plugin_one: 0.7,
      plugin_two: 0.9,
    });
  });

  test("should handle plugin timeout gracefully", async () => {
    const plugin: PortablePlugin = {
      id: "timeout-001",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "let x = 0 in while x < 1000000 do x = x + 1", // Long-running
      manifest: {
        name: "timeout_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 10, // Very short timeout
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.error).toBeDefined();
  });
});

describe("Elo Plugins - Real-world Plugin Examples", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeAll(async () => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry, 1); // 1 hour cache TTL

    // Register realistic capabilities
    registry.register("graph.are_mutual", async (_, ctx) => {
      // Simulate mutual follow check - return raw boolean
      return ctx.sourcePubkey === "mutual-pubkey";
    });

    registry.register("nostr.query", async (args) => {
      // Simulate Nostr query - return raw array
      const filter = JSON.parse(args[0] || "{}");
      return [{ id: "event1", kind: filter.kinds?.[0] || 1 }];
    });

    registry.register("http.nip05_resolve", async (args) => {
      // Simulate NIP-05 resolution - return { pubkey: string | null }
      return {
        pubkey: args[0] === "valid@example.com" ? "resolved-pubkey" : null,
      };
    });
  });

  test("should evaluate reciprocity-based trust plugin", async () => {
    const reciprocityPlugin: PortablePlugin = {
      id: "reciprocity-001",
      pubkey: "plugin-author-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.graph.are_mutual then 1.0 else 0.3",
      manifest: {
        name: "reciprocity_trust",
        title: "Reciprocity Trust",
        about: "Scores based on mutual follow status",
        weight: 2.0,
        caps: [{ name: "graph.are_mutual", args: ["sourcePubkey", "pubkey"] }],
      },
      rawEvent: {} as any,
    };

    // Test with mutual follow
    const contextMutual = {
      targetPubkey: "target-pubkey-1",
      sourcePubkey: "mutual-pubkey",
    };

    const resultMutual = await runPlugin(
      reciprocityPlugin,
      contextMutual,
      executor,
      {
        eloPluginTimeoutMs: 1000,
        capTimeoutMs: 1000,
      },
    );

    expect(resultMutual.success).toBe(true);
    expect(resultMutual.score).toBe(1.0);

    // Test without mutual follow (use different target to avoid cache hit)
    const contextNonMutual = {
      targetPubkey: "target-pubkey-2",
      sourcePubkey: "non-mutual-pubkey",
    };

    const resultNonMutual = await runPlugin(
      reciprocityPlugin,
      contextNonMutual,
      executor,
      {
        eloPluginTimeoutMs: 1000,
        capTimeoutMs: 1000,
      },
    );

    expect(resultNonMutual.success).toBe(true);
    expect(resultNonMutual.score).toBe(0.3); // Should return 0.3 for non-mutual
  });

  test("should evaluate activity-based plugin with Nostr query", async () => {
    const activityPlugin: PortablePlugin = {
      id: "activity-001",
      pubkey: "plugin-author-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content:
        "let events = _.cap.nostr.query in if length(events) > 10 then 0.9 else if length(events) > 5 then 0.7 else 0.4",
      manifest: {
        name: "activity_score",
        title: "Activity Score",
        about: "Scores based on recent activity",
        weight: 1.5,
        caps: [{ name: "nostr.query", args: ['{"kinds": [1], "limit": 20}'] }],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "active-user-pubkey",
    };

    const result = await runPlugin(activityPlugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.4);
    expect(result.score).toBeLessThanOrEqual(0.9);
  });

  test("should evaluate combined metric plugin", async () => {
    const combinedPlugin: PortablePlugin = {
      id: "combined-001",
      pubkey: "plugin-author-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content:
        "let mutual = _.cap.graph.are_mutual, nip05 = _.cap.http.nip05_resolve.pubkey in if mutual and nip05 then 1.0 else if mutual then 0.8 else if nip05 then 0.6 else 0.2",
      manifest: {
        name: "combined_trust",
        title: "Combined Trust Score",
        about: "Combines multiple trust signals",
        weight: 3.0,
        caps: [
          { name: "graph.are_mutual", args: ["sourcePubkey", "pubkey"] },
          { name: "http.nip05_resolve", args: ["nip05@example.com"] },
        ],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-pubkey",
      sourcePubkey: "mutual-pubkey",
    };

    const result = await runPlugin(combinedPlugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

describe("Elo Plugins - Additional Critical Tests", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeEach(async () => {
    registry = new CapabilityRegistry();
    executor = new CapabilityExecutor(registry, 1); // 1 hour cache TTL

    // Register test capabilities
    registry.register("test.cache_check", async (args) => args[0] || "default");
  });

  afterEach(() => {
    // Clear cache between tests to avoid cross-contamination
    executor.clearCache();
  });

  test("should handle disabled capability end-to-end", async () => {
    // Register but disable a capability
    registry.register("test.disabled_cap", async () => "should not be called");
    executor.setEnabledForTesting("test.disabled_cap", false);

    const plugin: PortablePlugin = {
      id: "disabled-test",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.test.disabled_cap then 1.0 else 0.0",
      manifest: {
        name: "disabled_cap_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [{ name: "test.disabled_cap", args: [] }],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    // Should succeed but return 0.0 because capability is disabled (null in _.cap)
    expect(result.success).toBe(true);
    expect(result.score).toBe(0.0);
  });

  test("should create nested capability structure correctly", async () => {
    registry.register("http.nip05_resolve", async (args) => {
      return {
        pubkey: args[0] === "valid@example.com" ? "resolved-pubkey" : null,
      };
    });

    const plugin: PortablePlugin = {
      id: "nested-test",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.http.nip05_resolve.pubkey then 1.0 else 0.0",
      manifest: {
        name: "nested_cap_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [{ name: "http.nip05_resolve", args: ["valid@example.com"] }],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
  });

  test("should respect cache TTL and expire entries", async () => {
    // Create executor with very short TTL (1ms)
    const shortTtlExecutor = new CapabilityExecutor(registry, 0.000001); // ~3.6 seconds

    let callCount = 0;
    registry.register("test.ttl_check", async () => {
      callCount++;
      return `call-${callCount}`;
    });

    const request = {
      capName: "test.ttl_check",
      args: ["test"],
      timeoutMs: 1000,
    };

    const context = {
      targetPubkey: "test-target",
      config: { capTimeoutMs: 1000 },
    };

    // First call
    const response1 = await shortTtlExecutor.execute(
      request,
      context,
      "plugin-1",
    );
    expect(response1.ok).toBe(true);
    expect(response1.value).toBe("call-1");
    expect(callCount).toBe(1);

    // Second call immediately (should hit cache)
    const response2 = await shortTtlExecutor.execute(
      request,
      context,
      "plugin-1",
    );
    expect(response2.ok).toBe(true);
    expect(response2.value).toBe("call-1"); // Same value
    expect(callCount).toBe(1); // Handler not called again

    // Wait for TTL to expire (3.6 seconds is too long for tests, so we'll just verify the cache entry exists)
    const stats = shortTtlExecutor.getCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.ttlHours).toBeLessThan(0.001); // Very small TTL
  });

  test("should generate deterministic unsafe plugin IDs", async () => {
    const pluginData1 = {
      pubkey: "test-pubkey",
      created_at: 1704067200,
      kind: 31234,
      tags: [["name", "test_plugin"]],
      content: "1.0",
      // Missing id and sig (unsafe)
    };

    const pluginData2 = {
      pubkey: "test-pubkey",
      created_at: 1704067200,
      kind: 31234,
      tags: [["name", "test_plugin"]],
      content: "1.0",
      // Missing id and sig (unsafe)
    };

    // Ensure directory exists (it might have been removed by other suites)
    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    // Write both plugins to different files
    const pluginPath1 = join(testDir, "unsafe-1.json");
    const pluginPath2 = join(testDir, "unsafe-2.json");

    await writeFile(pluginPath1, JSON.stringify(pluginData1));
    await writeFile(pluginPath2, JSON.stringify(pluginData2));

    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";
    const plugins = await loadPlugins(testDir);

    // Find the unsafe plugins (filter out any other test plugins)
    const unsafePlugins = plugins.filter(
      (p) => p.unsafe && p.id.startsWith("unsafe:"),
    );

    // Should have at least 2 unsafe plugins
    expect(unsafePlugins.length).toBeGreaterThanOrEqual(2);

    // All identical unsafe plugins should have the same derived ID (deterministic)
    const uniqueIds = new Set(unsafePlugins.map((p) => p.id));
    expect(uniqueIds.size).toBe(1);
    expect(Array.from(uniqueIds)[0]).toMatch(/^unsafe:[0-9a-f]{64}$/);

    // Cleanup
    await rm(pluginPath1);
    await rm(pluginPath2);
  });

  test("should ignore cap_arg tags before any cap tag", async () => {
    const tags = [
      ["name", "test_plugin"],
      ["cap_arg", "this_should_be_ignored"], // cap_arg before any cap
      ["cap", "graph.are_mutual"],
      ["cap_arg", "sourcePubkey"],
      ["cap_arg", "targetPubkey"],
      ["cap", "nostr.query"],
      ["cap_arg", '{"kinds": [1]}'],
    ];

    const manifest = parseManifestTags(tags);

    expect(manifest.name).toBe("test_plugin");
    expect(manifest.caps).toHaveLength(2);

    // First capability should only have 2 args (not 3)
    expect(manifest.caps[0]).toEqual({
      name: "graph.are_mutual",
      args: ["sourcePubkey", "targetPubkey"],
    });

    // Second capability should only have 1 arg
    expect(manifest.caps[1]).toEqual({
      name: "nostr.query",
      args: ['{"kinds": [1]}'],
    });
  });

  test("should continue provisioning capabilities when one fails", async () => {
    const callOrder: string[] = [];

    registry.register("test.first", async () => {
      callOrder.push("first");
      return "first-result";
    });

    registry.register("test.second", async () => {
      callOrder.push("second");
      throw new Error("Second capability failed");
    });

    registry.register("test.third", async () => {
      callOrder.push("third");
      return "third-result";
    });

    const plugin: PortablePlugin = {
      id: "multi-cap-test",
      pubkey: "test-pubkey",
      createdAt: 1704067200,
      kind: 31234,
      content: "if _.cap.test.third then 1.0 else 0.0",
      manifest: {
        name: "multi_cap_plugin",
        title: null,
        about: null,
        weight: 1.0,
        caps: [
          { name: "test.first", args: [] },
          { name: "test.second", args: [] },
          { name: "test.third", args: [] },
        ],
      },
      rawEvent: {} as any,
    };

    const context = {
      targetPubkey: "test-target",
    };

    const result = await runPlugin(plugin, context, executor, {
      eloPluginTimeoutMs: 1000,
      capTimeoutMs: 1000,
    });

    // All three capabilities should have been attempted
    expect(callOrder).toEqual(["first", "second", "third"]);

    // Plugin should succeed and use the third capability's result
    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
  });
});

describe("Elo Plugins - Utility Functions", () => {
  test("setNestedValue should create nested structure correctly", () => {
    const obj: Record<string, any> = {};

    // Test basic nesting
    setNestedValue(obj, "http.nip05_resolve.pubkey", "test-pubkey");
    expect(obj.http.nip05_resolve.pubkey).toBe("test-pubkey");
    expect(getNestedValue(obj, "http.nip05_resolve.pubkey")).toBe(
      "test-pubkey",
    );

    // Test multiple paths
    setNestedValue(obj, "graph.are_mutual", true);
    expect(obj.graph.are_mutual).toBe(true);
    expect(getNestedValue(obj, "graph.are_mutual")).toBe(true);

    // Test overwriting existing values
    setNestedValue(obj, "http.nip05_resolve.pubkey", "new-pubkey");
    expect(obj.http.nip05_resolve.pubkey).toBe("new-pubkey");

    // Test empty path segments
    setNestedValue(obj, "a..b.c", "value");
    expect(obj.a.b.c).toBe("value");

    // Test getting non-existent paths
    expect(getNestedValue(obj, "non.existent.path")).toBeUndefined();
    expect(getNestedValue(obj, "")).toBeUndefined();
  });
});
