import { beforeEach, describe, expect, test } from "bun:test";

import { CapabilityExecutor } from "@/capabilities/CapabilityExecutor";
import { CapabilityRegistry } from "@/capabilities/CapabilityRegistry";
import { registerBuiltInCapabilities } from "@/capabilities/registerBuiltInCapabilities";
import { RELATR_CAPABILITIES } from "@contextvm/relo";
import type { SocialGraph } from "@/graph/SocialGraph";

function errorMessageOf(
  response: Awaited<ReturnType<CapabilityExecutor["execute"]>>,
): string {
  expect(response.ok).toBe(false);

  const error = (response as { error: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

const TEST_CONFIG = {
  capTimeoutMs: 1000,
  nip05ResolveTimeoutMs: 1000,
  nip05CacheTtlSeconds: 60,
  nip05DomainCooldownSeconds: 60,
};

describe("runtime graph capability arg contracts", () => {
  let registry: CapabilityRegistry;
  let executor: CapabilityExecutor;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    registerBuiltInCapabilities(registry);
    executor = new CapabilityExecutor(registry);
  });

  test("graph.pubkey_exists accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphPubkeyExists,
        argsJson: { pubkey: "pk-a" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          isInGraph: async (pubkey: string) => pubkey === "pk-a",
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toBe(true);
  });

  test("graph.is_following accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphIsFollowing,
        argsJson: { followerPubkey: "pk-a", followedPubkey: "pk-b" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          doesFollow: async (followerPubkey: string, followedPubkey: string) =>
            followerPubkey === "pk-a" && followedPubkey === "pk-b",
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toBe(true);
  });

  test("graph.are_mutual accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphAreMutual,
        argsJson: { a: "pk-a", b: "pk-b" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          areMutualFollows: async (a: string, b: string) =>
            a === "pk-a" && b === "pk-b",
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toBe(true);
  });

  test("graph.distance_from_root accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphDistanceFromRoot,
        argsJson: { pubkey: "pk-a" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          getDistance: async (pubkey: string) => (pubkey === "pk-a" ? 2 : 1000),
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toBe(2);
  });

  test("graph.distance_between accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphDistanceBetween,
        argsJson: { sourcePubkey: "pk-a", targetPubkey: "pk-b" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          getDistanceBetween: async (
            sourcePubkey: string,
            targetPubkey: string,
          ) => (sourcePubkey === "pk-a" && targetPubkey === "pk-b" ? 3 : 1000),
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toBe(3);
  });

  test("graph.users_within_distance accepts object-shaped args from relo contract", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphUsersWithinDistance,
        argsJson: { distance: 2 },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
          getUsersUpToDistance: async (distance: number) =>
            distance === 2 ? ["pk-a", "pk-b"] : [],
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.value).toEqual(["pk-a", "pk-b"]);
  });

  test("graph.pubkey_exists reports a consistent missing-string-field error", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphPubkeyExists,
        argsJson: {},
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(errorMessageOf(response)).toBe(
      "graph.pubkey_exists requires a string 'pubkey' field in the arguments object",
    );
  });

  test("graph.is_following reports a consistent missing-string-field error", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphIsFollowing,
        argsJson: { followerPubkey: "pk-a" },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(errorMessageOf(response)).toBe(
      "graph.is_following requires a string 'followedPubkey' field in the arguments object",
    );
  });

  test("graph.users_within_distance reports a consistent invalid-number error", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphUsersWithinDistance,
        argsJson: { distance: -1 },
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        graph: {
          isInitialized: () => true,
        } as unknown as SocialGraph,
        config: TEST_CONFIG,
      },
    );

    expect(errorMessageOf(response)).toBe(
      "graph.users_within_distance requires a non-negative numeric 'distance' field in the arguments object",
    );
  });

  test("graph capabilities report a consistent missing-graph error", async () => {
    const response = await executor.execute(
      {
        capName: RELATR_CAPABILITIES.graphAllPubkeys,
        argsJson: {},
        timeoutMs: 1000,
      },
      {
        targetPubkey: "target",
        config: TEST_CONFIG,
      },
    );

    expect(errorMessageOf(response)).toBe(
      "SocialGraph not available in context",
    );
  });
});
