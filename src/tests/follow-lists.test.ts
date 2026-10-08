import { describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { EventStore } from "applesauce-core";
import type { RelayPool } from "applesauce-relay";
import { DuckDBSocialGraphAnalyzer } from "nostr-social-duck";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { concat, from, NEVER } from "rxjs";
import {
  fetchEventsForPubkeys,
  mergeFollowLists,
  negSyncFromRelays,
} from "@/utils/utils.nostr";

const pk = (n: number) => n.toString(16).padStart(64, "0");
const ROOT = pk(1);
const ALICE = pk(2);
const BOB = pk(3);
const CAROL = pk(4);
const DAVE = pk(5);
const ERIN = pk(6);
const MEDIA_ONLY = pk(7);

function followList(
  author: string,
  kind: number,
  createdAt: number,
  follows: string[],
): NostrEvent {
  return {
    id: `${author}-${kind}-${createdAt}`,
    pubkey: author,
    kind,
    created_at: createdAt,
    tags: follows.map((followed) => ["p", followed]),
    content: "",
    sig: "",
  };
}

describe("mergeFollowLists", () => {
  test("graph ingestion keeps the union of an author's newest contact and media follow lists", async () => {
    const db = await DuckDBInstance.create(":memory:");
    const graph = await DuckDBSocialGraphAnalyzer.connect(
      (await db.connect()) as never,
      undefined,
      ROOT,
    );

    await graph.ingestEvents(
      mergeFollowLists([
        followList(ROOT, 3, 100, [DAVE]), // superseded by the newer contact list
        followList(ROOT, 3, 200, [ALICE, BOB]),
        followList(ROOT, 10020, 150, [BOB, CAROL]),
        followList(MEDIA_ONLY, 10020, 100, [ERIN]),
      ]),
    );

    expect(
      await Promise.all(
        [ALICE, BOB, CAROL, DAVE].map((followed) =>
          graph.isDirectFollow(ROOT, followed),
        ),
      ),
    ).toEqual([true, true, true, false]);
    expect(await graph.isDirectFollow(MEDIA_ONLY, ERIN)).toBe(true);
    await graph.close();
  });

  test("produces one kind 3 list per author with each followed pubkey once and the newest timestamp", () => {
    const [merged] = mergeFollowLists([
      followList(ROOT, 3, 200, [ALICE, BOB]),
      followList(ROOT, 10020, 300, [BOB, CAROL]),
    ]);

    expect(merged!.kind).toBe(3);
    expect(merged!.created_at).toBe(300);
    expect(merged!.tags).toEqual([
      ["p", ALICE],
      ["p", BOB],
      ["p", CAROL],
    ]);
  });
});

describe("follow list fetching", () => {
  // The event store only accepts validly signed events.
  const [aliceKey, bobKey] = [generateSecretKey(), generateSecretKey()];
  const [alice, bob] = [getPublicKey(aliceKey), getPublicKey(bobKey)];
  const signed = (key: Uint8Array, kind: number, follows: string[]) =>
    finalizeEvent(
      { kind, created_at: 100, tags: follows.map((f) => ["p", f]), content: "" },
      key,
    );
  const lists = [
    signed(aliceKey, 3, [bob]),
    signed(aliceKey, 10020, [CAROL]),
    signed(bobKey, 3, [alice]),
  ];
  const matching = (filter: Filter) =>
    lists.filter(
      (e) =>
        filter.kinds!.includes(e.kind) && filter.authors!.includes(e.pubkey),
    );

  test("fetches every configured kind even from a relay that never finishes multi-kind syncs", async () => {
    // Like relay.nostr.net: a negentropy sync over several kinds never completes.
    const pool = {
      sync: (_relays: string[], _store: EventStore, filter: Filter) =>
        filter.kinds!.length > 1 ? NEVER : from(matching(filter)),
    } as unknown as RelayPool;
    const batches: NostrEvent[][] = [];

    await fetchEventsForPubkeys([alice, bob], [3, 10020], ["wss://relay.example"], pool, {
      onBatch: (events) => void batches.push(events),
    });

    expect(batches.flat().map((e) => e.id).sort()).toEqual(
      lists.map((e) => e.id).sort(),
    );
  }, 5_000);

  test("an aborted sync returns the events received before the abort", async () => {
    const filter = { kinds: [3], authors: [alice, bob] };
    const pool = {
      sync: () => concat(from(matching(filter)), NEVER),
    } as unknown as RelayPool;
    const controller = new AbortController();

    const pending = negSyncFromRelays(
      pool,
      ["wss://relay.example"],
      filter,
      controller.signal,
      new EventStore(),
    );
    controller.abort();

    expect((await pending).map((e) => e.id).sort()).toEqual(
      matching(filter).map((e) => e.id).sort(),
    );
  });
});
