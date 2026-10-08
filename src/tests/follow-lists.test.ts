import { describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDBSocialGraphAnalyzer } from "nostr-social-duck";
import type { NostrEvent } from "nostr-tools";
import { mergeFollowLists } from "@/utils/utils.nostr";

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
