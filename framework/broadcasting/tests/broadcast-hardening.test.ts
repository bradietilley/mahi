import { afterEach, describe, expect, it } from "vitest";
import {
  LocalBroadcastDriver,
  type LocalBroadcastDriverOptions,
} from "../src/drivers/local-broadcast-driver.js";
import { startTestServer, TestSocket, type TestServer } from "./websocket-test-helpers.js";

describe("LocalBroadcastDriver hardening (B3)", () => {
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

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
  });

  describe("origin allow-list", () => {
    it("refuses an upgrade whose Origin is not allow-listed", async () => {
      const { port } = await boot({ allowedOrigins: ["https://app.example.com"] });

      const allowed = await TestSocket.tryConnect(port, "/broadcasting/socket", {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(allowed).toBe(false);
    });

    it("accepts an upgrade from an allow-listed Origin", async () => {
      const { port } = await boot({ allowedOrigins: ["https://app.example.com"] });

      const socket = await TestSocket.connect(port, "/broadcasting/socket", {
        headers: { Origin: "https://app.example.com" },
      });
      sockets.push(socket);
      await socket.subscribe("posts");
    });

    it("still accepts a client that sends no Origin (non-browser)", async () => {
      const { port } = await boot({ allowedOrigins: ["https://app.example.com"] });

      const socket = await TestSocket.connect(port);
      sockets.push(socket);
      await socket.subscribe("posts");
    });
  });

  describe("subscription cap", () => {
    it("rejects the subscription past the per-socket limit", async () => {
      const { port } = await boot({ maxSubscriptionsPerSocket: 2 });
      const socket = await TestSocket.connect(port);
      sockets.push(socket);

      await socket.subscribe("a");
      await socket.subscribe("b");

      socket.send({ type: "subscribe", channel: "c" });
      expect(await socket.nextMessage()).toMatchObject({
        type: "subscription_error",
        channel: "c",
        error: expect.stringMatching(/limit/i),
      });
    });

    it("re-subscribing to an existing channel does not count against the cap", async () => {
      const { port } = await boot({ maxSubscriptionsPerSocket: 1 });
      const socket = await TestSocket.connect(port);
      sockets.push(socket);

      await socket.subscribe("a");
      // Re-subscribe to the same channel — still allowed.
      await socket.subscribe("a");
    });
  });

  describe("frame size limit", () => {
    it("closes the connection on an oversize inbound frame", async () => {
      const { port } = await boot({ maxFrameBytes: 64 });
      const socket = await TestSocket.connect(port);
      sockets.push(socket);

      const huge = "x".repeat(1000);
      socket.send({ type: "subscribe", channel: huge });
      expect(await socket.nextMessage()).toMatchObject({ error: expect.stringMatching(/size/i) });
    });
  });
});
