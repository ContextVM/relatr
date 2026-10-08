import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, TCPSocketListener } from "bun";
import { RelayPool } from "applesauce-relay";
import { finalizeEvent, generateSecretKey, type Filter } from "nostr-tools";
import { lastValueFrom, toArray } from "rxjs";
import { createConnectTimeoutWebSocket } from "@/utils/utils.nostr";

const EOSE_TIMEOUT_MS = 1_000;
const event = finalizeEvent(
  { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" },
  generateSecretKey(),
);

describe("relay connect timeout", () => {
  // The type parameter is the per-connection socket data; neither fake relay attaches any.
  let healthyRelay: Server<undefined>;
  // Accepts TCP connections but never answers the WebSocket handshake, like a host that drops packets.
  let unresponsiveRelay: TCPSocketListener<undefined>;
  let relays: string[];

  beforeAll(() => {
    healthyRelay = Bun.serve<undefined>({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          const [type, subId] = JSON.parse(String(raw));
          if (type !== "REQ") return;
          ws.send(JSON.stringify(["EVENT", subId, event]));
          ws.send(JSON.stringify(["EOSE", subId]));
        },
      },
    });
    unresponsiveRelay = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    relays = [
      `ws://127.0.0.1:${healthyRelay.port}`,
      `ws://127.0.0.1:${unresponsiveRelay.port}`,
    ];
  });

  afterAll(() => {
    healthyRelay.stop(true);
    unresponsiveRelay.stop(true);
  });

  test("an unresponsive relay stops delaying requests once its connect attempt times out", async () => {
    const pool = new RelayPool({
      WebSocket: createConnectTimeoutWebSocket(200),
      eoseTimeout: EOSE_TIMEOUT_MS,
    });
    const request = (filter: Filter) =>
      lastValueFrom(pool.request(relays, filter).pipe(toArray()));

    // The first request pays for the failed connect attempt.
    await request({ kinds: [1], limit: 1 });

    for (let i = 0; i < 3; i++) {
      const startedAt = performance.now();
      const events = await request({ kinds: [1], limit: 1 });

      expect(events.map((e) => e.id)).toEqual([event.id]);
      // Without the connect timeout, every request waits for the unresponsive relay's EOSE timeout.
      expect(performance.now() - startedAt).toBeLessThan(EOSE_TIMEOUT_MS / 2);
    }
  }, 30_000);

  test("a timed-out connection attempt reports exactly one unclean close", async () => {
    const ConnectTimeoutWebSocket = createConnectTimeoutWebSocket(100);
    const socket = new ConnectTimeoutWebSocket(relays[1]!);
    const closes: Array<{ code: number; wasClean: boolean }> = [];
    const firstClose = new Promise<void>((resolve) => {
      // The pool's WebSocket layer listens through the onclose handler.
      socket.onclose = (e) => {
        closes.push({ code: e.code, wasClean: e.wasClean });
        resolve();
      };
    });

    await firstClose;
    // A duplicate would be the runtime's own close arriving after the reported one; it lands within
    // a few milliseconds, and its absence cannot be awaited as an event.
    await Bun.sleep(50);

    expect(closes).toEqual([{ code: 1006, wasClean: false }]);
  });
});
