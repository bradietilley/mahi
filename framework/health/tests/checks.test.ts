import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, CACHE_TOKEN, DATABASE_TOKEN, STORAGE_TOKEN } from "@mahi/core";
import { ArrayCacheStore, CacheManager } from "@mahi/cache";
import type { CacheStore } from "@mahi/cache";
import { DatabaseManager, SqliteDriver } from "@mahi/database";
import { LocalStorageDriver, StorageManager } from "@mahi/storage";
import { cacheCheck, databaseCheck, filesystemCheck } from "../src/checks/index.js";

/**
 * Each check runs against the REAL backing implementation — a real
 * `ArrayCacheStore`, a real sqlite `DatabaseManager`, a real
 * `LocalStorageDriver` over a temp dir. The checks talk to those managers
 * through structural types (see `checks/contracts.ts`), so these tests are
 * what proves the structural types still match the real ones.
 */

function appWithCache(store: CacheStore): Application {
  const app = new Application();
  const manager = new CacheManager(app, { default: "test", stores: { test: {} } });
  manager.extend("test", () => store);
  app.singleton(CACHE_TOKEN, () => manager);

  return app;
}

function appWithDatabase(): Application {
  const app = new Application();
  const manager = new DatabaseManager(app, {
    default: "sqlite",
    connections: { sqlite: { filename: ":memory:" } },
  });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.singleton(DATABASE_TOKEN, () => manager);

  return app;
}

function appWithStorage(root: string): Application {
  const app = new Application();
  const manager = new StorageManager(app, {
    default: "local",
    disks: { local: { driver: "local", root } },
  });
  manager.extend("local", () => new LocalStorageDriver(root));
  app.singleton(STORAGE_TOKEN, () => manager);

  return app;
}

describe("cacheCheck", () => {
  it("passes against a working store", async () => {
    const app = appWithCache(new ArrayCacheStore());
    expect(await cacheCheck.run(app)).toBe(true);
  });

  it("skips when no cache is bound", async () => {
    expect(await cacheCheck.run(new Application())).toBeNull();
  });

  it("forgets its key on the success path", async () => {
    const store = new ArrayCacheStore();
    const app = appWithCache(store);

    await cacheCheck.run(app);

    // Nothing this check wrote may outlive it.
    const forgotten = await store.get("anything");
    expect(forgotten).toBeUndefined();
  });

  it("propagates the driver's message when put rejects", async () => {
    const store = new ArrayCacheStore();
    store.put = () => Promise.reject(new Error("connect ECONNREFUSED 10.0.1.4:6379"));
    const app = appWithCache(store);

    await expect(cacheCheck.run(app)).rejects.toThrow("connect ECONNREFUSED 10.0.1.4:6379");
  });

  it("fails when get returns a different value than was written", async () => {
    // The case a `put`-only check would miss entirely: writes are
    // accepted and discarded (a Redis replica, a full disk), so a bare
    // `put` reports healthy while every read is wrong.
    const store = new ArrayCacheStore();
    store.get = async () => "a value this check never wrote" as never;
    const app = appWithCache(store);

    const outcome = await cacheCheck.run(app);

    expect(outcome).toBe(
      'Cache read back "a value this check never wrote", expected the written value.',
    );
  });

  it("fails when get returns nothing at all", async () => {
    const store = new ArrayCacheStore();
    store.get = async () => undefined as never;
    const app = appWithCache(store);

    expect(await cacheCheck.run(app)).toBe(
      "Cache read back undefined, expected the written value.",
    );
  });

  it("still forgets its key when the read-back assertion fails", async () => {
    const store = new ArrayCacheStore();
    store.get = async () => "wrong" as never;
    let forgotten = false;
    const originalForget = store.forget.bind(store);
    store.forget = async (key: string) => {
      forgotten = true;

      return originalForget(key);
    };

    await cacheCheck.run(appWithCache(store));

    expect(forgotten).toBe(true);
  });

  it("does not turn a passing check into a failing one when cleanup fails", async () => {
    const store = new ArrayCacheStore();
    store.forget = () => Promise.reject(new Error("forget is broken"));

    // Failing to clean up a key with a 60s TTL is not a cache outage.
    expect(await cacheCheck.run(appWithCache(store))).toBe(true);
  });

  it("writes its key with a bounded TTL", async () => {
    const store = new ArrayCacheStore();
    let seenTtl: number | undefined;
    const originalPut = store.put.bind(store);
    store.put = async (key: string, value: unknown, ttlSeconds?: number) => {
      seenTtl = ttlSeconds;

      return originalPut(key, value, ttlSeconds);
    };

    await cacheCheck.run(appWithCache(store));

    // The TTL is what bounds the key's life if `forget` fails.
    expect(seenTtl).toBe(60);
  });

  it("does not collide when two runs overlap", async () => {
    const store = new ArrayCacheStore();
    const keys: string[] = [];
    const originalPut = store.put.bind(store);
    store.put = async (key: string, value: unknown, ttlSeconds?: number) => {
      keys.push(key);

      return originalPut(key, value, ttlSeconds);
    };
    const app = appWithCache(store);

    const [first, second] = await Promise.all([cacheCheck.run(app), cacheCheck.run(app)]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("databaseCheck", () => {
  it("passes against a working connection", async () => {
    expect(await databaseCheck.run(appWithDatabase())).toBe(true);
  });

  it("skips when no database is bound", async () => {
    expect(await databaseCheck.run(new Application())).toBeNull();
  });

  it("propagates the driver's error when the query fails", async () => {
    const app = new Application();
    const manager = new DatabaseManager(app, {
      default: "sqlite",
      connections: { sqlite: {} },
    });
    manager.extend("sqlite", () => ({
      dialect: "sqlite" as const,
      kysely: {
        selectNoFrom: () => ({
          execute: () => Promise.reject(new Error("SQLITE_CANTOPEN: unable to open database file")),
        }),
      } as never,
    }));
    app.singleton(DATABASE_TOKEN, () => manager);

    await expect(databaseCheck.run(app)).rejects.toThrow("SQLITE_CANTOPEN");
  });

  it("queries only the default connection", async () => {
    const app = new Application();
    let secondaryUsed = false;
    const manager = new DatabaseManager(app, {
      default: "primary",
      connections: { primary: {}, analytics: {} },
    });
    manager.extend("primary", () => new SqliteDriver({ filename: ":memory:" }));
    manager.extend("analytics", () => {
      // A deliberately-offline replica must not fail the probe.
      secondaryUsed = true;
      throw new Error("analytics replica is offline");
    });
    app.singleton(DATABASE_TOKEN, () => manager);

    expect(await databaseCheck.run(app)).toBe(true);
    expect(secondaryUsed).toBe(false);
  });
});

describe("filesystemCheck", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mahi-health-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes against a working disk", async () => {
    expect(await filesystemCheck.run(appWithStorage(root))).toBe(true);
  });

  it("skips when no storage is bound", async () => {
    expect(await filesystemCheck.run(new Application())).toBeNull();
  });

  it("deletes its file on the success path", async () => {
    await filesystemCheck.run(appWithStorage(root));

    // The `health-check/` directory may remain; no probe file may.
    const entries = await readdir(join(root, "health-check")).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("propagates the driver's message when put rejects", async () => {
    const app = new Application();
    const manager = new StorageManager(app, { default: "local", disks: { local: { root } } });
    manager.extend("local", () => {
      const driver = new LocalStorageDriver(root);
      driver.put = () => Promise.reject(new Error("EROFS: read-only file system"));

      return driver;
    });
    app.singleton(STORAGE_TOKEN, () => manager);

    await expect(filesystemCheck.run(app)).rejects.toThrow("EROFS: read-only file system");
  });

  it("fails when get returns a different value than was written", async () => {
    // `LocalStorageDriver.put()` is mkdir + writeFile, which succeeds on
    // a filesystem that went read-only after the mount was cached. Only
    // the read-back catches that.
    const app = new Application();
    const manager = new StorageManager(app, { default: "local", disks: { local: { root } } });
    manager.extend("local", () => {
      const driver = new LocalStorageDriver(root);
      driver.get = async () => Buffer.from("stale contents");

      return driver;
    });
    app.singleton(STORAGE_TOKEN, () => manager);

    expect(await filesystemCheck.run(app)).toBe(
      'Filesystem read back "stale contents", expected the written value.',
    );
  });

  it("still deletes its file when the read-back assertion fails", async () => {
    const app = new Application();
    let deleted = false;
    const manager = new StorageManager(app, { default: "local", disks: { local: { root } } });
    manager.extend("local", () => {
      const driver = new LocalStorageDriver(root);
      driver.get = async () => Buffer.from("wrong");
      const originalDelete = driver.delete.bind(driver);
      driver.delete = async (path: string) => {
        deleted = true;

        return originalDelete(path);
      };

      return driver;
    });
    app.singleton(STORAGE_TOKEN, () => manager);

    await filesystemCheck.run(app);

    expect(deleted).toBe(true);
  });

  it("does not turn a passing check into a failing one when cleanup fails", async () => {
    const app = new Application();
    const manager = new StorageManager(app, { default: "local", disks: { local: { root } } });
    manager.extend("local", () => {
      const driver = new LocalStorageDriver(root);
      driver.delete = () => Promise.reject(new Error("delete is broken"));

      return driver;
    });
    app.singleton(STORAGE_TOKEN, () => manager);

    // A broken delete leaves a diagnostic artifact, not an outage.
    expect(await filesystemCheck.run(app)).toBe(true);
  });

  it("confines its artifacts to the health-check/ prefix", async () => {
    const app = new Application();
    const written: string[] = [];
    const manager = new StorageManager(app, { default: "local", disks: { local: { root } } });
    manager.extend("local", () => {
      const driver = new LocalStorageDriver(root);
      const originalPut = driver.put.bind(driver);
      driver.put = async (path: string, contents: Buffer | string) => {
        written.push(path);

        return originalPut(path, contents);
      };

      return driver;
    });
    app.singleton(STORAGE_TOKEN, () => manager);

    await filesystemCheck.run(app);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^health-check\/.+\.txt$/);
  });

  it("does not collide when two runs overlap", async () => {
    const app = appWithStorage(root);

    const [first, second] = await Promise.all([filesystemCheck.run(app), filesystemCheck.run(app)]);

    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});

describe("the built-in checks as a set", () => {
  it('all declare the "core" group', () => {
    for (const check of [cacheCheck, databaseCheck, filesystemCheck]) {
      expect(check.group).toBe("core");
    }
  });

  it("are named for the dependency they probe", () => {
    expect([cacheCheck.name, databaseCheck.name, filesystemCheck.name]).toEqual([
      "cache",
      "database",
      "filesystem",
    ]);
  });
});
