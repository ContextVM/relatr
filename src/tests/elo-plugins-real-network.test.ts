import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { RelayPool } from "applesauce-relay";
import { loadPluginsFromDirectory } from "@/plugins/PortablePluginLoader";
import { CapabilityRegistry } from "@/capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "@/capabilities/CapabilityExecutor";
import { registerBuiltInCapabilities } from "@/capabilities/registerBuiltInCapabilities";
import { runPlugin } from "@/plugins/EloPluginRunner";

const RUN_REAL_NETWORK_TESTS = process.env.RUN_REAL_NETWORK_TESTS === "true";

// Real-world fixtures (operator-provided)
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const GIGI_PUBKEY =
  "6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93";
const GIGI_NIP05 = "_@dergigi.com";
const MUTUAL_TARGET_PUBKEY =
  "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
// Note: activity is inherently noisy on real relays; assert a minimum tier instead of exact.
const MIN_ACTIVITY_TIER: 0.0 | 0.3 | 0.6 | 1.0 = 0.6;

describe("Elo Plugins v0 - real-network dogfooding (opt-in)", () => {
  let pool: RelayPool;
  let graph: any;
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeAll(async () => {
    if (!RUN_REAL_NETWORK_TESTS) return;

    // Allow loading unsigned plugins from ./test-plugins (dev/test only)
    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";

    pool = new RelayPool();
    // Avoid expensive network-backed social graph creation in tests.
    // We keep the graph capability path realistic by providing a minimal stub
    // that answers the mutual-follow check for the fixture pair.
    graph = {
      isInitialized: () => true,
      areMutualFollows: async (a: string, b: string) =>
        a === GIGI_PUBKEY && b === MUTUAL_TARGET_PUBKEY,
    };

    registry = new CapabilityRegistry();
    registerBuiltInCapabilities(registry);
    executor = new CapabilityExecutor(registry);
  }, 120_000);

  afterAll(async () => {
    if (!RUN_REAL_NETWORK_TESTS) return;
    // no-op (graph is a stub)
  });

  const realTest = RUN_REAL_NETWORK_TESTS ? test : test.skip;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  realTest(
    "should load dogfooding plugins from test-plugins/",
    async () => {
      const plugins = await loadPluginsFromDirectory("test-plugins");
      const names = plugins.map((p) => p.manifest.name).sort();
      expect(names).toEqual(
        [
          "activity_notes",
          "nip05_valid",
          "reciprocity_mutual",
          "root_nip05",
        ].sort(),
      );
    },
    30_000,
  );

  realTest(
    "root_nip05 should score 1.0 for _@dergigi.com",
    async () => {
      const plugins = await loadPluginsFromDirectory("test-plugins");
      const plugin = plugins.find((p) => p.manifest.name === "root_nip05");
      expect(plugin).toBeTruthy();

      const result = await runPlugin(
        plugin!,
        {
          targetPubkey: GIGI_PUBKEY,
          pool,
          relays: RELAYS,
          graph,
        },
        executor,
        { eloPluginTimeoutMs: 30_000, capTimeoutMs: 12_000 },
      );

      expect(result.success).toBe(true);
      // Hard assertion: this should be stable for the fixture pubkey.
      expect(result.score).toBe(1.0);
    },
    60_000,
  );

  realTest(
    "nip05_valid should score 1.0 when NIP-05 resolves to the target pubkey",
    async () => {
      // Sanity check for fixture data (helps debug if the profile changes)
      expect(GIGI_NIP05).toBe("_@dergigi.com");

      const plugins = await loadPluginsFromDirectory("test-plugins");
      const plugin = plugins.find((p) => p.manifest.name === "nip05_valid");
      expect(plugin).toBeTruthy();

      // NIP-05 resolution is real-network + DNS/HTTP dependent; allow retries
      // to avoid occasional transient failures.
      let lastScore: number | null = null;
      let lastSuccess: boolean | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await runPlugin(
          plugin!,
          {
            targetPubkey: GIGI_PUBKEY,
            pool,
            relays: RELAYS,
            graph,
          },
          executor,
          { eloPluginTimeoutMs: 60_000, capTimeoutMs: 20_000 },
        );

        lastScore = result.score;
        lastSuccess = result.success;

        if (result.success && result.score === 1.0) break;
        await sleep(250);
      }

      expect(lastSuccess).toBe(true);
      expect(lastScore).toBe(1.0);
    },
    60_000,
  );

  realTest(
    "activity_notes should return the expected activity tier (heuristic)",
    async () => {
      const plugins = await loadPluginsFromDirectory("test-plugins");
      const plugin = plugins.find((p) => p.manifest.name === "activity_notes");
      expect(plugin).toBeTruthy();

      const result = await runPlugin(
        plugin!,
        {
          targetPubkey: GIGI_PUBKEY,
          pool,
          relays: RELAYS,
          graph,
        },
        executor,
        { eloPluginTimeoutMs: 30_000, capTimeoutMs: 12_000 },
      );

      expect(result.success).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(MIN_ACTIVITY_TIER);
    },
    60_000,
  );

  realTest(
    "reciprocity_mutual should score 1.0 for the provided mutual-follow pair",
    async () => {
      const plugins = await loadPluginsFromDirectory("test-plugins");
      const plugin = plugins.find(
        (p) => p.manifest.name === "reciprocity_mutual",
      );
      expect(plugin).toBeTruthy();

      const result = await runPlugin(
        plugin!,
        {
          sourcePubkey: GIGI_PUBKEY,
          targetPubkey: MUTUAL_TARGET_PUBKEY,
          pool,
          relays: RELAYS,
          graph,
        },
        executor,
        { eloPluginTimeoutMs: 30_000, capTimeoutMs: 12_000 },
      );

      expect(result.success).toBe(true);
      expect(result.score).toBe(1.0);
    },
    60_000,
  );
});
