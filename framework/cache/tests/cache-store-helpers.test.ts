import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CacheStore } from "../src/cache-store.js";
import { ArrayCacheStore } from "../src/stores/array-cache-store.js";
import { FileCacheStore } from "../src/stores/file-cache-store.js";
import { rememberViaLock } from "../src/cache-store-helpers.js";

/**
 * See the note in `stores/file-cache-store.test.ts`: a 50ms TTL leaves the
 * preceding `remember()` and `get()` racing disk I/O, and under a loaded
 * run they lose — expiring the value before the first assertion reads it.
 */
const TTL_SECONDS = 1;

function sleepPastTtl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TTL_SECONDS * 1000 + 250));
}

/**
 * `remember()`/`rememberViaLock()`/`lock()` are implemented once in
 * `cache-store-helpers.ts` and delegated to by every `CacheStore` — so
 * this suite runs the same behavioral tests against both built-in
 * stores rather than duplicating them per-store.
 */
describe.each<{
  name: string;
  build: () => Promise<{ store: CacheStore; cleanup: () => Promise<void> }>;
}>([
  {
    name: "ArrayCacheStore",
    build: async () => ({ store: new ArrayCacheStore(), cleanup: async () => {} }),
  },
  {
    name: "FileCacheStore",
    build: async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-cache-helpers-test-"));
      const store = new FileCacheStore(path.join(tmpDir, "cache"));

      return { store, cleanup: () => rm(tmpDir, { recursive: true, force: true }) };
    },
  },
])("$name", ({ build }) => {
  let store: CacheStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await build());
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("remember()", () => {
    it("runs the callback and caches its result on a miss", async () => {
      let calls = 0;
      const value = await store.remember("key", () => {
        calls += 1;

        return "computed";
      });

      expect(value).toBe("computed");
      expect(calls).toBe(1);
      expect(await store.get("key")).toBe("computed");
    });

    it("returns the cached value without calling the callback again on a hit", async () => {
      let calls = 0;
      const callback = () => {
        calls += 1;

        return "computed";
      };

      await store.remember("key", callback);
      const second = await store.remember("key", callback);

      expect(second).toBe("computed");
      expect(calls).toBe(1);
    });

    it("supports an async callback", async () => {
      const value = await store.remember("key", async () => {
        await Promise.resolve();

        return "async value";
      });

      expect(value).toBe("async value");
    });

    it("defaults ttlSeconds to null (no expiry)", async () => {
      await store.remember("key", () => "value");
      expect(await store.get("key")).toBe("value");
    });

    it("respects an explicit ttlSeconds", async () => {
      await store.remember("key", () => "value", TTL_SECONDS);
      expect(await store.get("key")).toBe("value");

      await sleepPastTtl();
      expect(await store.get("key")).toBeUndefined();
    });
  });

  describe("lock()", () => {
    it("returns a Lock scoped to this store", async () => {
      const lock = store.lock({ key: "job", automaticReleaseAfterSeconds: 10 });
      await lock.acquire();

      expect(await store.has("job_lock")).toBe(true);
      await lock.release();
      expect(await store.has("job_lock")).toBe(false);
    });
  });

  describe("rememberViaLock()", () => {
    it("runs the callback and caches its result on a miss", async () => {
      let calls = 0;
      const value = await store.rememberViaLock("key", () => {
        calls += 1;

        return "computed";
      });

      expect(value).toBe("computed");
      expect(calls).toBe(1);
      expect(await store.get("key")).toBe("computed");
    });

    it("returns the cached value without acquiring a lock or calling the callback again on a hit", async () => {
      let calls = 0;
      const callback = () => {
        calls += 1;

        return "computed";
      };

      await store.rememberViaLock("key", callback);
      const second = await store.rememberViaLock("key", callback);

      expect(second).toBe("computed");
      expect(calls).toBe(1);
    });

    it("releases the lock after computing the value", async () => {
      await store.rememberViaLock("key", () => "value");
      expect(await store.has("key_lock")).toBe(false);
    });

    it("only runs the callback once across a cache-miss stampede of concurrent callers", async () => {
      let calls = 0;
      const callback = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));

        return "computed";
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.rememberViaLock("stampede-key", callback)),
      );

      expect(calls).toBe(1);
      expect(results.every((r) => r === "computed")).toBe(true);
    });

    it("does not block forever on a crashed lock holder — it falls back to computing", async () => {
      // Simulate a holder that acquired the lock and never released it (a
      // crash), by taking the lock directly and leaving it. A waiter must
      // NOT hang until the auto-release TTL; it waits a bounded time, then
      // re-checks the cache and computes the value itself.
      const held = await store.add("crashed_lock", "someone-else", 30);
      expect(held).toBe(true);

      let calls = 0;
      const started = Date.now();
      const value = await rememberViaLock(
        store,
        "crashed",
        () => {
          calls += 1;

          return "fallback";
        },
        null,
        // A short wait so the test is fast; the crashed holder's lock has a
        // much longer TTL, proving we don't wait for it to lapse.
        { ttlSeconds: 30, waitSeconds: 0 },
      );

      expect(value).toBe("fallback");
      expect(calls).toBe(1);
      // Well under the 30s TTL — we fell back rather than blocking on it.
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
