import { Application } from "@mahi/core";
import { HttpKernel } from "@mahi/http";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBroadcastDriver } from "../src/drivers/local-broadcast-driver.js";
import {
  startTestServer,
  TestSocket,
  waitUntil,
  type TestServer,
} from "./websocket-test-helpers.js";

describe("LocalBroadcastDriver", () => {
  let server: TestServer | undefined;
  const sockets: TestSocket[] = [];

  async function boot(): Promise<{ driver: LocalBroadcastDriver; port: number }> {
    const driver = new LocalBroadcastDriver();
    server = await startTestServer(driver);

    return { driver, port: server.port };
  }

  async function connect(port: number): Promise<TestSocket> {
    const socket = await TestSocket.connect(port);
    sockets.push(socket);

    return socket;
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  it("delivers a broadcast to a client subscribed to that channel", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);
    await client.subscribe("todos");

    await driver.broadcast({
      channel: "todos",
      event: "TodoCreated",
      payload: { id: "1", title: "Ship it" },
    });

    expect(await client.nextMessage()).toEqual({
      channel: "todos",
      event: "TodoCreated",
      payload: { id: "1", title: "Ship it" },
    });
  });

  it("does not deliver to a client subscribed to a different channel", async () => {
    const { driver, port } = await boot();
    const subscriber = await connect(port);
    const bystander = await connect(port);
    await subscriber.subscribe("todos");
    await bystander.subscribe("users");

    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: { id: "1" } });

    expect(await subscriber.nextMessage()).toMatchObject({ event: "TodoCreated" });
    await expect(bystander.expectNoMessage()).resolves.toBeUndefined();
  });

  it("delivers to every client subscribed to the same channel", async () => {
    const { driver, port } = await boot();
    const first = await connect(port);
    const second = await connect(port);
    await first.subscribe("todos");
    await second.subscribe("todos");

    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: { id: "1" } });

    expect(await first.nextMessage()).toMatchObject({ event: "TodoCreated" });
    expect(await second.nextMessage()).toMatchObject({ event: "TodoCreated" });
  });

  it("stops delivering after a client unsubscribes", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);
    await client.subscribe("todos");
    await client.unsubscribe("todos");

    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: { id: "1" } });

    await expect(client.expectNoMessage()).resolves.toBeUndefined();
    expect(driver.subscriberCount("todos")).toBe(0);
  });

  it("is a no-op when nobody is subscribed to the channel", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);
    await client.subscribe("todos");

    await expect(
      driver.broadcast({ channel: "nobody-here", event: "Whatever", payload: {} }),
    ).resolves.toBeUndefined();
    await expect(client.expectNoMessage()).resolves.toBeUndefined();
  });

  it("forgets a socket when it closes, so subscriptions do not leak", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);
    await client.subscribe("todos");
    expect(driver.subscriberCount("todos")).toBe(1);

    await client.close();

    await waitUntil(() => driver.subscriberCount("todos") === 0);
    expect(driver.channels()).toEqual([]);
  });

  it("keeps delivering to live sockets when another subscriber has gone away", async () => {
    const { driver, port } = await boot();
    const staying = await connect(port);
    const leaving = await connect(port);
    await staying.subscribe("todos");
    await leaving.subscribe("todos");

    await leaving.close();
    await waitUntil(() => driver.subscriberCount("todos") === 1);

    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: { id: "1" } });

    expect(await staying.nextMessage()).toMatchObject({ event: "TodoCreated" });
  });

  it("answers an unparseable or unknown frame with an error, without dropping the connection", async () => {
    const { driver, port } = await boot();
    const client = await connect(port);

    client.send("not json at all");
    expect(await client.nextMessage()).toMatchObject({ error: expect.any(String) });

    client.send({ type: "subscribe" });
    expect(await client.nextMessage()).toMatchObject({ error: expect.any(String) });

    // Still usable afterwards.
    await client.subscribe("todos");
    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: {} });
    expect(await client.nextMessage()).toMatchObject({ event: "TodoCreated" });
  });

  it("mounts its endpoint on the app's own server, leaving plain HTTP routes working", async () => {
    const driver = new LocalBroadcastDriver();
    const { Hono } = await import("hono");
    const hono = new Hono();
    hono.get("/health", (c) => c.text("ok"));
    server = await startTestServer(driver, hono);

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("serves the websocket at a custom path when configured", async () => {
    const driver = new LocalBroadcastDriver("/ws");
    server = await startTestServer(driver);

    const client = await TestSocket.connect(server.port, "/ws");
    sockets.push(client);
    await client.subscribe("todos");

    await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: {} });

    expect(await client.nextMessage()).toMatchObject({ event: "TodoCreated" });
  });

  it("refuses to inject a server before its routes have been registered", () => {
    const driver = new LocalBroadcastDriver();

    expect(() => driver.injectWebSocket({} as never)).toThrow(/registerRoutes/);
  });

  /**
   * The reason `registerRoutes()` takes a helper at all. An application
   * with a websocket route of its own has to share this driver's
   * `createNodeWebSocket()`, because two of them on one Node server crash
   * the process on the first connection — see `WebSocketSupport` in
   * `@mahi/http`. These two cases are what "shared" has to mean.
   */
  describe("sharing the kernel's websocket helper", () => {
    it("serves both its own endpoint and the application's on one helper", async () => {
      const kernel = new HttpKernel(new Application());
      const support = kernel.websocketSupport();
      const hono = kernel.raw();

      // The application's route, registered on the SAME helper the driver
      // is about to be handed.
      hono.get(
        "/terminals/socket",
        support.upgradeWebSocket(() => ({ onOpen: (_e, ws) => ws.send("pty") })),
      );

      const driver = new LocalBroadcastDriver();
      server = await startTestServer(driver, hono, support);

      // The application's socket answers...
      const pty = await TestSocket.connect(server.port, "/terminals/socket");
      sockets.push(pty);
      expect(await pty.nextRawFrame()).toBe("pty");

      // ...and so does the broadcast one, on the same server.
      const client = await TestSocket.connect(server.port);
      sockets.push(client);
      await client.subscribe("todos");
      await driver.broadcast({ channel: "todos", event: "TodoCreated", payload: {} });
      expect(await client.nextMessage()).toMatchObject({ event: "TodoCreated" });
    });

    it("attaches one upgrade listener however many times injection is asked for", () => {
      const kernel = new HttpKernel(new Application());
      const support = kernel.websocketSupport();

      const driver = new LocalBroadcastDriver();
      driver.registerRoutes(kernel.raw(), support);

      // Several parties each believe injection is their job — the kernel,
      // `listenHttpServer()`, and an app following the driver's own
      // documented entrypoint snippet. A second `upgrade` listener is the
      // crash this design prevents, so the extra calls must be no-ops
      // rather than an ordering rule nobody can follow.
      let listeners = 0;
      const server = { on: () => listeners++ } as never;

      driver.injectWebSocket(server);
      driver.injectWebSocket(server);
      kernel.injectWebSocket(server);

      expect(listeners).toBe(1);
    });
  });
});
