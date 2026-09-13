import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, clearCurrentApp } from "@mahiframework/core";
import { CacheServiceProvider, CACHE_TOKEN, type CacheManager } from "@mahiframework/cache";
import { BroadcastManager, BROADCAST_TOKEN } from "@mahiframework/broadcasting";
import { RedisServiceProvider, REDIS_TOKEN } from "../src/redis-service-provider.js";
import { RedisManager } from "../src/redis-manager.js";
import { RedisBroadcastDriver } from "../src/drivers/redis-broadcast-driver.js";
import type { RedisConnection } from "../src/redis-connection.js";
import { REDIS_UNAVAILABLE } from "./redis-test-helpers.js";

afterEach(() => {
  clearCurrentApp();
});

/**
 * Boots a real Application with the cache + redis providers. The redis
 * config points at a port nothing listens on, so if `boot()` ever tries
 * to connect again this suite fails loudly (either by throwing, or, the
 * bug this guards, by leaving a socket open) rather than passing only on
 * machines that happen to run Redis.
 */
async function bootApp(cacheDefault: string): Promise<Application> {
  const app = new Application();
  app.useEnvironment("test");

  app.config.set("cache", { default: cacheDefault, stores: { array: {}, redis: {} } });
  app.config.set("redis", {
    default: "default",
    connections: { default: { host: "127.0.0.1", port: 63999 } },
  });

  app.register(CacheServiceProvider);
  app.register(RedisServiceProvider);
  await app.bootstrap();

  return app;
}

describe("RedisServiceProvider", () => {
  /**
   * The base application lists `RedisServiceProvider` by default so
   * switching to Redis is a config change, which makes "listed but
   * unused" the common case. Connecting unconditionally in `boot()` would
   * leave an ioredis socket open, and an open socket keeps Node's event
   * loop alive, so every short-lived process that boots the app
   * (`./artisan migrate`, `key:generate`, any CLI command, a test run)
   * would finish its work and then hang forever.
   */
  it("does not connect when nothing is pointed at redis", async () => {
    const app = await bootApp("array");

    const manager = app.make<RedisManager>(REDIS_TOKEN);

    // No connection was ever resolved, so nothing could have opened a
    // socket, `Manager` caches by name, so an empty resolved list is
    // proof that `boot()` never touched it.
    expect(manager.resolvedDriverNames()).toEqual([]);
  });

  it("registers a redis cache store without resolving it", async () => {
    const app = await bootApp("array");

    // The driver is registered and selectable by name; it just isn't
    // constructed (and therefore isn't connected) until something asks.
    expect(app.has(REDIS_TOKEN)).toBe(true);
    expect(app.make<RedisManager>(REDIS_TOKEN).resolvedDriverNames()).toEqual([]);
  });
});

/**
 * The mirror of "don't connect unless selected" above, and the reason a
 * `schedule:run` cron invocation with `CACHE_STORE=redis` exits instead
 * of accumulating a zombie process per minute: an open ioredis socket
 * keeps Node's event loop alive on its own, so `terminate()` must reach
 * `RedisConnection.disconnect()` for every connection that was resolved.
 */
describe("RedisServiceProvider.shutdown()", () => {
  it("disconnects every connection that was resolved", async () => {
    const app = await bootApp("array");

    const manager = app.make<RedisManager>(REDIS_TOKEN);
    // Resolve without connecting. `lazyConnect` means no socket opens,
    // so this works against the dead port the config points at.
    const connection = manager.connection();
    const disconnect = vi.spyOn(connection, "disconnect").mockResolvedValue();

    await app.terminate();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(manager.resolvedDriverNames()).toEqual([]);
  });

  /**
   * Resolving a connection in order to close it would CONSTRUCT an
   * ioredis client, opening the very thing shutdown exists to avoid
   * leaving open.
   */
  it("does not resolve a connection that was never used", async () => {
    const app = await bootApp("array");
    const manager = app.make<RedisManager>(REDIS_TOKEN);

    await app.terminate();

    expect(manager.resolvedDriverNames()).toEqual([]);
  });

  it("is a no-op when the redis token was never resolved", async () => {
    const app = await bootApp("array");
    expect(app.isResolved(REDIS_TOKEN)).toBe(false);

    await expect(app.terminate()).resolves.toBeUndefined();
    expect(app.isResolved(REDIS_TOKEN)).toBe(false);
  });

  it("logs a failing disconnect rather than aborting the rest of shutdown", async () => {
    const app = await bootApp("array");
    const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});

    const manager = app.make<RedisManager>(REDIS_TOKEN);
    vi.spyOn(manager.connection(), "disconnect").mockRejectedValue(new Error("boom"));

    await expect(app.terminate()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("failed to quit"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  /**
   * `RedisBroadcastDriver.disconnect()` likewise had no caller. Its
   * subscriber is a *duplicated* client, so it is stopped before the
   * connection it was duplicated from.
   */
  it("stops a resolved redis broadcast driver's subscriber", async () => {
    const app = new Application();
    app.useEnvironment("test");
    app.config.set("cache", { default: "array", stores: { array: {} } });
    app.config.set("redis", {
      default: "default",
      connections: { default: { host: "127.0.0.1", port: 63999 } },
    });

    // Bound directly rather than via BroadcastServiceProvider, which
    // would drag in the events and http providers for no benefit here.
    // All this needs is a BroadcastManager for `extendBroadcast()` to
    // register the redis driver onto.
    app.instance(
      BROADCAST_TOKEN,
      new BroadcastManager(app, { default: "redis", connections: { redis: {} } }),
    );
    app.register(CacheServiceProvider);
    app.register(RedisServiceProvider);
    await app.bootstrap();

    const redis = app.make<RedisManager>(REDIS_TOKEN);
    const broadcaster = app.make<BroadcastManager>(BROADCAST_TOKEN);
    const driver = broadcaster.connection("redis") as RedisBroadcastDriver;
    const driverDisconnect = vi.spyOn(driver, "disconnect").mockResolvedValue();
    const connectionDisconnect = vi.spyOn(redis.connection(), "disconnect").mockResolvedValue();

    await app.terminate();

    expect(driverDisconnect).toHaveBeenCalledOnce();
    expect(connectionDisconnect).toHaveBeenCalledOnce();
    expect(driverDisconnect.mock.invocationCallOrder[0]).toBeLessThan(
      connectionDisconnect.mock.invocationCallOrder[0]!,
    );
  });
});

/**
 * The end-to-end claim: a process that boots an app pointed at Redis
 * exits after `terminate()`, because there is no live socket left holding
 * the event loop open. Needs a real server, a client that never
 * connected has nothing to quit, which is the case the unit tests above
 * cover.
 */
describe.skipIf(REDIS_UNAVAILABLE)("RedisServiceProvider.shutdown() (integration)", () => {
  it("closes the socket a live connection was holding open", async () => {
    const app = new Application();
    app.useEnvironment("test");
    app.config.set("cache", { default: "redis", stores: { redis: {} } });
    app.config.set("redis", {
      default: "default",
      connections: { default: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" } },
    });
    app.register(CacheServiceProvider);
    app.register(RedisServiceProvider);
    await app.bootstrap();

    // `boot()` connected the default connection because cache selects it.
    const connection = app.make<RedisManager>(REDIS_TOKEN).connection() as RedisConnection;
    expect(connection.client().status).toBe("ready");

    // Prove the cache actually works over it before tearing it down.
    await app.make<CacheManager>(CACHE_TOKEN).store().put("k", "v", 5);

    await app.terminate();

    // The socket that was keeping the event loop alive is gone: any
    // further command rejects rather than reconnecting. (`status` only
    // flips to `"end"` on the next tick, so the command is the assertion
    // that does not race.)
    await expect(connection.client().get("k")).rejects.toThrow(/Connection is closed/);
  });
});
