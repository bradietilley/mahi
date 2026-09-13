import { afterEach, describe, expect, it } from "vitest";
import { RedisConnection } from "../src/redis-connection.js";
import { REDIS_UNAVAILABLE, testConnection } from "./redis-test-helpers.js";

describe("RedisConnection (config: no server needed)", () => {
  it("parses a redis:// url into host/port/db", () => {
    const connection = new RedisConnection({ url: "redis://localhost:6390/3" });
    const client = connection.client();
    expect(client.options.host).toBe("localhost");
    expect(client.options.port).toBe(6390);
    expect(client.options.db).toBe(3);
    client.disconnect();
  });

  it("parses credentials and tls from a rediss:// url", () => {
    const connection = new RedisConnection({ url: "rediss://user:pass@example.com:6380" });
    const client = connection.client();
    expect(client.options.username).toBe("user");
    expect(client.options.password).toBe("pass");
    expect(client.options.host).toBe("example.com");
    expect(client.options.tls).toBeDefined();
    client.disconnect();
  });

  it("uses discrete host/port/db fields when no url is given", () => {
    const connection = new RedisConnection({
      host: "10.0.0.1",
      port: 6399,
      db: 2,
      keyPrefix: "app:",
    });
    const client = connection.client();
    expect(client.options.host).toBe("10.0.0.1");
    expect(client.options.port).toBe(6399);
    expect(client.options.db).toBe(2);
    expect(client.options.keyPrefix).toBe("app:");
    client.disconnect();
  });

  it("does not open a socket eagerly (lazyConnect)", () => {
    const connection = new RedisConnection({ host: "127.0.0.1" });
    // Never connected. Status stays 'wait' until connect() is called.
    expect(connection.client().status).toBe("wait");
    connection.client().disconnect();
  });
});

describe.skipIf(REDIS_UNAVAILABLE)("RedisConnection (integration)", () => {
  let connection: RedisConnection | undefined;

  afterEach(async () => {
    if (connection) {
      // Guarded: a test may have already disconnected on purpose.
      try {
        await connection.disconnect();
      } catch {
        /* already closed */
      }
      connection = undefined;
    }
  });

  it("connect() then a round-trip command works", async () => {
    connection = await testConnection();
    await connection.client().set("ping", "pong");
    expect(await connection.client().get("ping")).toBe("pong");
  });

  it("duplicate() yields an independent client tracked for disconnect", async () => {
    const local = await testConnection();
    const dup = local.duplicate();
    await dup.connect();
    expect(dup).not.toBe(local.client());

    await local.disconnect(); // should also close the duplicate
    // Give the close event a tick to propagate.
    await new Promise((r) => setTimeout(r, 50));
    expect(["end", "close"]).toContain(dup.status);
  });

  it("connect() is idempotent (double connect is a no-op)", async () => {
    connection = await testConnection();
    await expect(connection.connect()).resolves.toBeUndefined();
  });
});
