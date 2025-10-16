import { expect, test, describe } from "bun:test";
import { config } from "./environment";

describe("Environment Configuration", () => {
  test("should load configuration successfully", () => {
    expect(config).toBeDefined();
    expect(config.DEFAULT_SOURCE_PUBKEY).toBeString();
    expect(config.DEFAULT_SOURCE_PUBKEY).toHaveLength(64);
  });

  test("should have correct default values", () => {
    expect(config.GRAPH_BINARY_PATH).toBe("data/socialGraph.bin");
    expect(config.DB_PATH).toBe("data/relatr.db");
    expect(config.DECAY_FACTOR).toBe(0.1);
    expect(config.MAX_DISTANCE).toBe(1000);
    expect(config.CACHE_TTL).toBe(3600);
    expect(config.WEIGHTING_SCHEME).toBe("default");
    expect(config.AUTO_SAVE_INTERVAL).toBe(300000);
    expect(config.ENABLE_AUTO_SAVE).toBe(false);
  });

  test("should have correct feature flags", () => {
    expect(config.ENABLE_NIP05).toBe(true);
    expect(config.ENABLE_LIGHTNING).toBe(true);
    expect(config.ENABLE_EVENT_KIND_10002).toBe(true);
    expect(config.ENABLE_RECIPROCITY).toBe(true);
  });

  test("should parse nostr relays correctly", () => {
    expect(config.NOSTR_RELAYS).toBeArray();
    expect(config.NOSTR_RELAYS).toContain("wss://relay.damus.io");
    expect(config.NOSTR_RELAYS).toContain("wss://relay.nostr.band");
  });

  test("should validate numeric ranges", () => {
    expect(config.DECAY_FACTOR).toBeGreaterThan(0);
    expect(config.DECAY_FACTOR).toBeLessThanOrEqual(1);
    expect(config.CACHE_TTL).toBeGreaterThanOrEqual(0);
    expect(config.MAX_DISTANCE).toBeGreaterThan(0);
    expect(config.AUTO_SAVE_INTERVAL).toBeGreaterThan(0);
  });
});