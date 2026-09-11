import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import WebSocket from "ws";
import { RedisBroadcastDriver } from "../src/drivers/redis-broadcast-driver.js";
import type { RedisConnection } from "../src/redis-connection.js";
import { REDIS_UNAVAILABLE, testConnection, testPrefix } from "./redis-test-helpers.js";

/**
 * The whole point of this driver: a broadcast issued by one process
 * reaches a client connected to a *different* process, via Redis pub/sub.
 * Each "process" here is a separate RedisBroadcastDriver with its own
 * RedisConnection + HTTP server, which is exactly the multi-process
 * topology `LocalBroadcastDriver` silently fails.
 */
describe.skipIf(REDIS_UNAVAILABLE)("RedisBroadcastDriver (integration)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const connections: RedisConnection[] = [];
  const sockets: WebSocket[] = [];

  // A unique channel per suite run so concurrent runs / leftover state
  // never cross-talk.
  const channel = `mahi:test:${Math.random().toString(36).slice(2)}`;
  // Every "process" in this suite belongs to ONE application, so they all
  // share a key prefix — which the driver prepends to the pub/sub channel
  // name. Giving each its own random prefix models two *different*
  // applications, which are correctly isolated and never see one another's
  // broadcasts.
  const prefix = testPrefix();

  async function startProcess(
    options: Partial<import("@mahi/broadcasting").LocalBroadcastDriverOptions> & {
      keyPrefix?: string;
    } = {},
  ): Promise<{ driver: RedisBroadcastDriver; port: number }> {
    const { keyPrefix: prefixOverride, ...driverOptions } = options;
    const connection = await testConnection({ keyPrefix: prefixOverride ?? prefix });
    connections.push(connection);

    const driver = new RedisBroadcastDriver(connection, { ...driverOptions, channel });
    const hono = new Hono();
    driver.registerRoutes(hono);

    const server: ServerType = serve({ fetch: hono.fetch, port: 0 });
    driver.injectWebSocket(server);
    await once(server, "listening");
    await driver.connect();

    cleanups.push(async () => {
      await driver.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const { port } = server.address() as AddressInfo;

    return { driver, port };
  }

  async function connect(port: number, query = ""): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/broadcasting/socket${query}`);
    await once(socket, "open");
    sockets.push(socket);

    return socket;
  }

  function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for ws message")),
        timeoutMs,
      );
      socket.once("message", (data: WebSocket.RawData) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  async function subscribe(socket: WebSocket, ch: string): Promise<void> {
    const ack = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", channel: ch }));
    await ack;
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }

    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }

    for (const connection of connections.splice(0)) {
      await connection.disconnect();
    }

    vi.restoreAllMocks();
  });

  it("delivers a broadcast from process B to a client connected to process A", async () => {
    const processA = await startProcess();
    const processB = await startProcess();

    const client = await connect(processA.port);
    await subscribe(client, "posts");

    const message = nextMessage(client);
    await processB.driver.broadcast({
      channel: "posts",
      event: "PostCreated",
      payload: { id: 7 },
    });

    expect(await message).toEqual({ channel: "posts", event: "PostCreated", payload: { id: 7 } });
  });

  it("a client only receives broadcasts for channels it subscribed to", async () => {
    const processA = await startProcess();
    const processB = await startProcess();

    const client = await connect(processA.port);
    await subscribe(client, "posts");

    // Broadcast to a different channel — must not arrive.
    await processB.driver.broadcast({ channel: "other", event: "X", payload: {} });

    await expect(nextMessage(client, 300)).rejects.toThrow(/timed out/);
  });

  it("delivers a locally-issued broadcast to a local subscriber too (single-process still works)", async () => {
    const processA = await startProcess();
    const client = await connect(processA.port);
    await subscribe(client, "posts");

    const message = nextMessage(client);
    await processA.driver.broadcast({ channel: "posts", event: "Local", payload: { ok: true } });

    expect(await message).toEqual({ channel: "posts", event: "Local", payload: { ok: true } });
  });

  it("does NOT cross-deliver between two apps with different key prefixes (B4)", async () => {
    // Two independent apps on one Redis server, distinguished only by
    // keyPrefix. The pub/sub channel is prefixed, so a broadcast in app B
    // must never reach a client of app A. ioredis does NOT apply a
    // connection's keyPrefix to PUBLISH/SUBSCRIBE (a channel is not a key),
    // so the driver prepends it by hand — without that, two co-tenants
    // share the one `mahi:broadcast` channel and leak each other's events.
    const appA = await startProcess({
      keyPrefix: `tsf-appA:${Math.random().toString(36).slice(2)}:`,
    });
    const appB = await startProcess({
      keyPrefix: `tsf-appB:${Math.random().toString(36).slice(2)}:`,
    });

    const client = await connect(appA.port);
    await subscribe(client, "posts");

    await appB.driver.broadcast({ channel: "posts", event: "ShouldNotArrive", payload: {} });

    await expect(nextMessage(client, 300)).rejects.toThrow(/timed out/);
  });

  /**
   * A throw inside the subscriber's message pump would, if it escaped, be
   * an uncaught exception that Node terminates the process for by default —
   * so one failed delivery would take the whole server down rather than
   * dropping one frame. The pump swallows a throwing fan-out; the next
   * broadcast still delivers.
   */
  it("survives a throwing local fan-out and keeps delivering afterwards", async () => {
    const process = await startProcess();

    const client = await connect(process.port);
    await subscribe(client, "posts");

    // Force the local fan-out to throw exactly once, the way a dead socket
    // mid-send would — the subscriber callback must catch it, not crash.
    const driverInternals = process.driver as unknown as {
      deliverLocalFrame: (channel: string, frame: string, excludeSocketId?: string) => void;
    };
    const spy = vi.spyOn(driverInternals, "deliverLocalFrame").mockImplementationOnce(() => {
      throw new Error("fan-out exploded");
    });

    await process.driver.broadcast({ channel: "posts", event: "Boom", payload: {} });
    // Give the pump a tick to process (and swallow) the poisoned publish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    spy.mockRestore();

    // The process is still alive and delivery has fully recovered.
    const message = nextMessage(client);
    await process.driver.broadcast({
      channel: "posts",
      event: "Recovered",
      payload: { ok: true },
    });
    expect(await message).toEqual({ channel: "posts", event: "Recovered", payload: { ok: true } });
  });

  describe("presence across processes", () => {
    const authorizer = {
      resolveUser: (context: import("hono").Context) =>
        new URL(context.req.url).searchParams.get("user"),
      authorize: async (_channel: string, user: unknown) =>
        typeof user === "string"
          ? { authorized: true, presenceData: { id: user } }
          : { authorized: false },
    };

    it("tells a member on process A when a member joins on process B", async () => {
      const processA = await startProcess({ authorizer });
      const processB = await startProcess({ authorizer });

      const alice = await connect(processA.port, "?user=alice");
      alice.send(JSON.stringify({ type: "subscribe", channel: "presence-room" }));
      await nextMessage(alice); // subscribed
      await nextMessage(alice); // presence:here

      const joining = nextMessage(alice);
      const bob = await connect(processB.port, "?user=bob");
      bob.send(JSON.stringify({ type: "subscribe", channel: "presence-room" }));

      expect(await joining).toEqual({
        type: "presence:joining",
        channel: "presence-room",
        member: { id: "bob" },
      });
    });

    it("includes members from other processes in the here roster (shared roster)", async () => {
      const processA = await startProcess({ authorizer });
      const processB = await startProcess({ authorizer });

      const alice = await connect(processA.port, "?user=alice");
      alice.send(JSON.stringify({ type: "subscribe", channel: "presence-room" }));
      await nextMessage(alice); // subscribed
      await nextMessage(alice); // here

      const bob = await connect(processB.port, "?user=bob");
      bob.send(JSON.stringify({ type: "subscribe", channel: "presence-room" }));
      await nextMessage(bob); // subscribed
      const here = (await nextMessage(bob)) as { type: string; members: Array<{ id: string }> };

      expect(here.type).toBe("presence:here");
      expect(here.members).toEqual(expect.arrayContaining([{ id: "alice" }, { id: "bob" }]));
    });
  });
});
