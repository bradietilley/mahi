import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, clearCurrentApp } from "@mahiframework/core";
import {
  CacheServiceProvider,
  CACHE_TOKEN,
  RATE_LIMITER_TOKEN,
} from "../src/cache-service-provider.js";
import { CacheManager } from "../src/cache-manager.js";
import { ArrayCacheStore } from "../src/stores/array-cache-store.js";
import { FileCacheStore } from "../src/stores/file-cache-store.js";
import { CacheClearCommand } from "../src/commands/cache-clear.js";
import { CachePruneCommand } from "../src/commands/cache-prune.js";
import { RateLimiter } from "../src/rate-limiting/rate-limiter.js";

async function buildApp(cache?: Record<string, unknown>): Promise<Application> {
  const app = new Application();
  app.useEnvironment("test");
  app.config.set(
    "cache",
    cache ?? { default: "array", stores: { array: {}, file: { path: "/tmp/mahi-unused-cache" } } },
  );
  app.register(CacheServiceProvider);
  await app.bootstrap();

  return app;
}

afterEach(() => {
  clearCurrentApp();
});

describe("CacheServiceProvider", () => {
  it("registers a CacheManager singleton resolving the configured default store", async () => {
    const app = await buildApp();
    const manager = app.make<CacheManager>(CACHE_TOKEN);
    expect(manager.store()).toBeInstanceOf(ArrayCacheStore);
  });

  it("registers a RateLimiter singleton backed by the app's default cache store", async () => {
    const app = await buildApp();
    const limiter = app.make<RateLimiter>(RATE_LIMITER_TOKEN);
    expect(limiter).toBeInstanceOf(RateLimiter);

    await limiter.hit("key");
    expect(await limiter.attempts("key")).toBe(1);
  });

  it("the RateLimiter and CacheManager's default store share state (same underlying store instance)", async () => {
    const app = await buildApp();
    const manager = app.make<CacheManager>(CACHE_TOKEN);
    const limiter = app.make<RateLimiter>(RATE_LIMITER_TOKEN);

    await limiter.hit("shared-key");
    // The RateLimiter writes through the same CacheStore instance
    // CacheManager.store() resolves — visible directly via the store.
    expect(await manager.store().get<number>("shared-key")).toBe(1);
  });

  it("contributes the cache:clear and cache:prune commands", async () => {
    const app = await buildApp();
    const provider = new CacheServiceProvider(app);
    expect(provider.commands()).toEqual([CacheClearCommand, CachePruneCommand]);
  });

  describe("the file store", () => {
    it("uses the configured path as a directory", async () => {
      const app = await buildApp({
        default: "file",
        stores: { file: { path: "/tmp/mahi-configured-cache" } },
      });
      expect(app.make<CacheManager>(CACHE_TOKEN).store()).toBeInstanceOf(FileCacheStore);
    });

    /**
     * The store now keeps one file per key under a *directory*, so an app
     * whose config predates that (or omits the block) must still resolve
     * to something usable rather than throwing at resolution time.
     */
    it("falls back to storage/cache when no path is configured", async () => {
      const app = await buildApp({ default: "file", stores: {} });
      expect(app.make<CacheManager>(CACHE_TOKEN).store()).toBeInstanceOf(FileCacheStore);
    });
  });

  describe("shutdown()", () => {
    /**
     * `ArrayCacheStore` runs a periodic sweep timer. It is `unref()`ed, so
     * it can never be the reason a process fails to exit, but a test run
     * that builds hundreds of Applications would otherwise accumulate one
     * live timer each.
     */
    it("disconnects every store that was resolved", async () => {
      const app = await buildApp();
      const store = app.make<CacheManager>(CACHE_TOKEN).store();
      const disconnect = vi.spyOn(store as ArrayCacheStore, "disconnect");

      await app.terminate();

      expect(disconnect).toHaveBeenCalledOnce();
    });

    it("does not resolve a store that was never used", async () => {
      const app = await buildApp();
      const manager = app.make<CacheManager>(CACHE_TOKEN);

      await app.terminate();

      expect(manager.resolvedDriverNames()).toEqual([]);
    });

    it("is a no-op when the cache token was never resolved", async () => {
      const app = await buildApp();
      expect(app.isResolved(CACHE_TOKEN)).toBe(false);

      await expect(app.terminate()).resolves.toBeUndefined();
      expect(app.isResolved(CACHE_TOKEN)).toBe(false);
    });

    it("logs a failing disconnect rather than aborting the rest of shutdown", async () => {
      const app = await buildApp();
      const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});
      const store = app.make<CacheManager>(CACHE_TOKEN).store();
      vi.spyOn(store as ArrayCacheStore, "disconnect").mockRejectedValue(new Error("boom"));

      await expect(app.terminate()).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("failed to shut down a store"),
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });
  });
});

describe("cache:clear", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("empties the default store", async () => {
    const app = await buildApp();
    const store = app.make<CacheManager>(CACHE_TOKEN).store();
    await store.put("key", "value");

    await new CacheClearCommand(app).handle({});

    expect(await store.get("key")).toBeUndefined();
  });

  it("empties the store named by --store, leaving the default alone", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-cache-cmd-"));
    const app = await buildApp({
      default: "array",
      stores: { array: {}, file: { path: path.join(tmpDir, "cache") } },
    });
    const manager = app.make<CacheManager>(CACHE_TOKEN);
    await manager.store("array").put("in-array", 1);
    await manager.store("file").put("in-file", 1);

    await new CacheClearCommand(app).handle({ store: "file" });

    expect(await manager.store("file").get("in-file")).toBeUndefined();
    expect(await manager.store("array").get("in-array")).toBe(1);
  });
});

describe("cache:prune", () => {
  it("removes expired entries and reports the count", async () => {
    const app = await buildApp();
    const store = app.make<CacheManager>(CACHE_TOKEN).store() as ArrayCacheStore;
    await store.put("dead", 1, 0.01);
    await store.put("live", 2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    await new CachePruneCommand(app).handle({});

    expect(store.size()).toBe(1);
  });

  /**
   * A scheduled `cache:prune` must not start failing the day someone
   * switches `cache.default` to a store that expires keys itself.
   */
  it("reports rather than throws on a store with no prune()", async () => {
    const app = await buildApp();
    const manager = app.make<CacheManager>(CACHE_TOKEN);
    manager.extend("pruneless", () => {
      const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });

      return Object.assign(Object.create(Object.getPrototypeOf(store) as object), store, {
        prune: undefined,
      }) as ArrayCacheStore;
    });

    await expect(
      new CachePruneCommand(app).handle({ store: "pruneless" }),
    ).resolves.toBeUndefined();
  });
});
