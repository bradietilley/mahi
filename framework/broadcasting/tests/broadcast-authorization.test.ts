import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  LocalBroadcastDriver,
  type LocalBroadcastDriverOptions,
} from "../src/drivers/local-broadcast-driver.js";
import type { BroadcastAuthorizer, SubscribeAuthorization } from "../src/broadcast-authorizer.js";
import { startTestServer, TestSocket, type TestServer } from "./websocket-test-helpers.js";

/**
 * A hand-rolled authorizer so the driver's own tests take no dependency on
 * `@mahi/auth`/`@mahi/encryption`. It authenticates a socket from a
 * `?user=` query param and authorizes private/presence channels from a
 * small in-memory table.
 */
class FakeAuthorizer implements BroadcastAuthorizer {
  constructor(
    private readonly rules: Record<string, (user: string | null) => SubscribeAuthorization> = {},
    private readonly grants: Record<string, SubscribeAuthorization> = {},
  ) {}

  resolveUser(context: Context): string | null {
    const url = new URL(context.req.url);

    return url.searchParams.get("user");
  }

  async authorize(channel: string, user: unknown): Promise<SubscribeAuthorization> {
    const rule = this.rules[channel];

    if (!rule) {
      return { authorized: false };
    }

    return rule(user as string | null);
  }

  verifyGrant(channel: string, grant: string): SubscribeAuthorization | null {
    const expected = this.grants[`${channel}|${grant}`];

    return expected ?? null;
  }
}

describe("LocalBroadcastDriver channel authorization", () => {
  let server: TestServer | undefined;
  const sockets: TestSocket[] = [];

  async function boot(options: LocalBroadcastDriverOptions = {}): Promise<{
    driver: LocalBroadcastDriver;
    port: number;
  }> {
    const driver = new LocalBroadcastDriver(options);
    server = await startTestServer(driver);

    return { driver, port: server.port };
  }

  async function connect(port: number, query = ""): Promise<TestSocket> {
    const socket = await TestSocket.connect(port, `/broadcasting/socket${query}`);
    sockets.push(socket);

    return socket;
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  it("still lets any client subscribe to a public channel with no authorizer", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);
    await client.subscribe("posts");

    await driver.broadcast({ channel: "posts", event: "PostCreated", payload: { id: "1" } });
    expect(await client.nextMessage()).toMatchObject({ event: "PostCreated" });
  });

  it("rejects a private channel when no authorizer is configured (fail closed)", async () => {
    const { port } = await boot();
    const client = await connect(port);

    client.send({ type: "subscribe", channel: "private-orders.1" });
    expect(await client.nextMessage()).toMatchObject({
      type: "subscription_error",
      channel: "private-orders.1",
      error: expect.any(String),
    });
  });

  it("allows a private subscription the authorizer approves", async () => {
    const authorizer = new FakeAuthorizer({
      "private-orders.1": (user) => ({ authorized: user === "alice" }),
    });
    const { driver, port } = await boot({ authorizer });
    const client = await connect(port, "?user=alice");

    client.send({ type: "subscribe", channel: "private-orders.1" });
    expect(await client.nextMessage()).toMatchObject({
      type: "subscribed",
      channel: "private-orders.1",
    });

    await driver.broadcast({
      channel: "private-orders.1",
      event: "OrderShipped",
      payload: { id: "1" },
    });
    expect(await client.nextMessage()).toMatchObject({ event: "OrderShipped" });
  });

  it("denies a private subscription the authorizer rejects, and never delivers to it", async () => {
    const authorizer = new FakeAuthorizer({
      "private-orders.1": (user) => ({ authorized: user === "alice" }),
    });
    const { driver, port } = await boot({ authorizer });
    const client = await connect(port, "?user=mallory");

    client.send({ type: "subscribe", channel: "private-orders.1" });
    expect(await client.nextMessage()).toMatchObject({ type: "subscription_error" });

    await driver.broadcast({
      channel: "private-orders.1",
      event: "OrderShipped",
      payload: { id: "1" },
    });
    await expect(client.expectNoMessage()).resolves.toBeUndefined();
    expect(driver.subscriberCount("private-orders.1")).toBe(0);
  });

  it("accepts a valid signed grant on the subscribe frame", async () => {
    const authorizer = new FakeAuthorizer(
      {},
      { "private-reports|good-grant": { authorized: true } },
    );
    const { driver, port } = await boot({ authorizer });
    const client = await connect(port);

    client.send({ type: "subscribe", channel: "private-reports", auth: "good-grant" });
    expect(await client.nextMessage()).toMatchObject({
      type: "subscribed",
      channel: "private-reports",
    });

    await driver.broadcast({ channel: "private-reports", event: "Ready", payload: {} });
    expect(await client.nextMessage()).toMatchObject({ event: "Ready" });
  });

  it("falls back to the callback path when the grant is invalid", async () => {
    const authorizer = new FakeAuthorizer({
      "private-reports": () => ({ authorized: false }),
    });
    const { port } = await boot({ authorizer });
    const client = await connect(port);

    client.send({ type: "subscribe", channel: "private-reports", auth: "bogus" });
    expect(await client.nextMessage()).toMatchObject({ type: "subscription_error" });
  });

  it("reports an authorization callback that throws as a subscription_error, not a crash", async () => {
    const authorizer: BroadcastAuthorizer = {
      resolveUser: () => null,
      authorize: () => {
        throw new Error("boom");
      },
    };
    const { port } = await boot({ authorizer });
    const client = await connect(port);

    client.send({ type: "subscribe", channel: "private-x" });
    expect(await client.nextMessage()).toMatchObject({ type: "subscription_error" });

    // The connection survives and can still use a public channel.
    await client.subscribe("posts");
  });
});
