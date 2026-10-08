import { describe, expect, test } from "bun:test";
import type { RelayPool } from "applesauce-relay";
import type { Filter, NostrEvent } from "nostr-tools";
import { from, NEVER, throwError } from "rxjs";
import { SchedulerService } from "@/service/SchedulerService";
import { fetchLastSeenAt } from "@/utils/utils.nostr";
import type { ProfileMetrics } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

function mkEvent(pubkey: string, createdAt: number, n = 0): NostrEvent {
  return {
    id: `${pubkey}-${createdAt}-${n}`,
    pubkey,
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: "",
    sig: "",
  };
}

/**
 * Relay pool stand-in that answers like a relay: matching events newest first, capped at `limit`.
 * Only `request` is used by the code under test.
 */
function mkPool(events: NostrEvent[]): RelayPool {
  return {
    request: (_relays: string[], filter: Filter) =>
      from(
        events
          .filter(
            (e) =>
              (!filter.authors || filter.authors.includes(e.pubkey)) &&
              e.created_at >= (filter.since ?? 0),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? Infinity),
      ),
  } as unknown as RelayPool;
}

describe("fetchLastSeenAt", () => {
  test("finds quiet authors hidden behind a prolific author's result limit", async () => {
    const since = NOW - 30 * 86400;
    const prolific = Array.from({ length: 600 }, (_, i) =>
      mkEvent("pk-prolific", NOW - i, i),
    );
    const pool = mkPool([
      ...prolific,
      mkEvent("pk-quiet", NOW - 10 * 86400),
      mkEvent("pk-quiet", NOW - 20 * 86400),
      mkEvent("pk-old", NOW - 60 * 86400),
    ]);

    const lastSeen = await fetchLastSeenAt(
      pool,
      ["wss://relay.example"],
      ["pk-prolific", "pk-quiet", "pk-old", "pk-silent"],
      since,
    );

    expect(Object.fromEntries(lastSeen)).toEqual({
      "pk-prolific": NOW,
      "pk-quiet": NOW - 10 * 86400,
    });
  });
});

describe("SchedulerService activity ordering", () => {
  const graphOrder = ["pk-a", "pk-b", "pk-c", "pk-d"];

  function mkScheduler(
    pool: RelayPool,
    seenBatches: string[][],
    storedLastSeen: Record<string, number> = {},
  ) {
    const kv = new Map<string, string>(
      Object.entries(storedLastSeen).map(([pk, ts]) => [pk, String(ts)]),
    );
    const settings = new Map<string, string>();
    const mkMetrics = (pubkey: string): ProfileMetrics => ({
      pubkey,
      metrics: { "pk:plugin": 1 },
      computedAt: NOW,
      expiresAt: NOW + 3600,
    });

    return new SchedulerService(
      {
        defaultSourcePubkey: "pk-source",
        nostrRelays: ["wss://relay.example"],
        syncIntervalHours: 21,
      } as never,
      {} as never,
      { getAllUsersInGraph: async () => graphOrder } as never,
      {
        hasConfiguredValidators: () => true,
        validateAllBatch: async (pubkeys: string[]) => {
          seenBatches.push([...pubkeys]);
          return new Map(pubkeys.map((pk) => [pk, mkMetrics(pk)]));
        },
      } as never,
      {
        getBatch: async (pubkeys: string[]) =>
          new Map(pubkeys.map((pubkey) => [pubkey, { pubkey }])),
      } as never,
      {} as never,
      {
        get: async (key: string) => settings.get(key) ?? null,
        getBatch: async (keys: string[]) =>
          new Map(keys.map((key) => [key, settings.get(key) ?? null])),
        set: async (key: string, value: string) => void settings.set(key, value),
        delete: async (key: string) => void settings.delete(key),
      } as never,
      pool,
      undefined,
      {
        getAllForKey: async () => new Map(kv),
        setMany: async (_key: string, values: Map<string, string>) => {
          values.forEach((value, pubkey) => kv.set(pubkey, value));
        },
      } as never,
    );
  }

  test("validates every graph pubkey, most recently active first and unseen ones in graph order", async () => {
    const seenBatches: string[][] = [];
    const scheduler = mkScheduler(
      mkPool([
        mkEvent("pk-a", NOW - 5 * 86400),
        mkEvent("pk-c", NOW - 86400),
      ]),
      seenBatches,
    );

    await scheduler.syncValidations(10);

    expect(seenBatches).toEqual([["pk-c", "pk-a", "pk-b", "pk-d"]]);
  });

  test("falls back to graph order when activity cannot be fetched", async () => {
    const seenBatches: string[][] = [];
    const scheduler = mkScheduler(
      {
        request: () => throwError(() => new Error("relays unreachable")),
      } as unknown as RelayPool,
      seenBatches,
    );

    await scheduler.syncValidations(10);

    expect(seenBatches).toEqual([graphOrder]);
  });

  test("orders by the previous scan without waiting for a due scan to finish", async () => {
    const seenBatches: string[][] = [];
    const scheduler = mkScheduler(
      // A scan that never completes; the run must not wait for it.
      { request: () => NEVER } as unknown as RelayPool,
      seenBatches,
      { "pk-d": NOW - 3600 },
    );

    await scheduler.syncValidations(10);

    expect(seenBatches).toEqual([["pk-d", "pk-a", "pk-b", "pk-c"]]);
  });
});
