import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArrayCacheStore } from "../../src/stores/array-cache-store.js";
import type { CacheStore } from "../../src/cache-store.js";
import { Lock, type LockOptions } from "../../src/locking/lock.js";
import { LockTimeoutError } from "../../src/locking/lock-timeout-error.js";

describe("Lock", () => {
  it("acquire() succeeds immediately when the lock is free", async () => {
    const store = new ArrayCacheStore();
    const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

    await expect(lock.acquire()).resolves.toBeUndefined();
  });

  it("acquire() sets a store entry under '<key>_lock'", async () => {
    const store = new ArrayCacheStore();
    const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

    await lock.acquire();

    expect(await store.has("job_lock")).toBe(true);
    expect(await store.has("job")).toBe(false);
  });

  it("release() removes the underlying store entry", async () => {
    const store = new ArrayCacheStore();
    const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

    await lock.acquire();
    await lock.release();

    expect(await store.has("job_lock")).toBe(false);
  });

  it("release() before acquire() is a safe no-op", async () => {
    const store = new ArrayCacheStore();
    const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("a second Lock instance can't acquire() while the first holds it", async () => {
    const store = new ArrayCacheStore();
    const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    const second = new Lock(store, {
      key: "job",
      automaticReleaseAfterSeconds: 10,
      maximumWaitForSeconds: 0,
    });

    await first.acquire();

    await expect(second.acquire()).rejects.toThrow(LockTimeoutError);
  });

  it("a second Lock instance can acquire() once the first releases it", async () => {
    const store = new ArrayCacheStore();
    const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    const second = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

    await first.acquire();
    await first.release();

    await expect(second.acquire()).resolves.toBeUndefined();
  });

  it("forceRelease() releases a lock acquired by a DIFFERENT instance (cross-process unique-job release)", async () => {
    const store = new ArrayCacheStore();
    // The dispatcher acquires the lock.
    const dispatcher = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    await dispatcher.acquire();

    // A held lock blocks a fresh acquire.
    const blocked = new Lock(store, {
      key: "job",
      automaticReleaseAfterSeconds: 10,
      maximumWaitForSeconds: 0,
    });
    await expect(blocked.acquire()).rejects.toThrow(LockTimeoutError);

    // A separate "worker" instance (never acquired) force-releases by key.
    const worker = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    await worker.forceRelease();

    // Now the lock is free.
    const after = new Lock(store, {
      key: "job",
      automaticReleaseAfterSeconds: 10,
      maximumWaitForSeconds: 0,
    });
    await expect(after.acquire()).resolves.toBeUndefined();
  });

  it("release() only releases the lock if this instance is still the owner (doesn't steal a lock re-acquired by someone else)", async () => {
    vi.useFakeTimers();
    try {
      const store = new ArrayCacheStore();
      const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 1 });
      await first.acquire();

      // The lock auto-expires after 1s (automaticReleaseAfterSeconds), letting someone else acquire it.
      vi.advanceTimersByTime(1_001);
      const second = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
      await second.acquire();

      // `first`'s belated release() must not steal `second`'s lock.
      await first.release();

      expect(await store.get("job_lock")).toBeDefined();
      await expect(second.release()).resolves.toBeUndefined();
      expect(await store.has("job_lock")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquire() retries and eventually succeeds once the lock is released by someone else", async () => {
    const store = new ArrayCacheStore();
    const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    await first.acquire();

    const second = new Lock(store, {
      key: "job",
      automaticReleaseAfterSeconds: 10,
      maximumWaitForSeconds: 5,
      retryEvery: 20,
    });
    const acquiring = second.acquire();

    setTimeout(() => void first.release(), 50);

    await expect(acquiring).resolves.toBeUndefined();
  });

  it("acquire() throws LockTimeoutError once the maximum wait budget elapses without acquiring", async () => {
    const store = new ArrayCacheStore();
    const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
    await first.acquire();

    const second = new Lock(store, {
      key: "job",
      automaticReleaseAfterSeconds: 10,
      maximumWaitForSeconds: 0.1,
      retryEvery: 20,
    });

    await expect(second.acquire()).rejects.toThrow(LockTimeoutError);
  });

  it("throws when no automatic-release TTL is provided", () => {
    const store = new ArrayCacheStore();
    // Cast: the type now requires the TTL, but a JS caller can still omit it.
    expect(() => new Lock(store, { key: "job" } as unknown as LockOptions)).toThrow(
      /automatic-release TTL/,
    );
  });

  describe("the TTL floor", () => {
    /**
     * `Math.ceil(0)` is `0`, which every store reads as "no expiry",
     * so a lock configured with a zero TTL was a lock with no recovery
     * path at all. A `WithoutOverlapping({ expireAfterSeconds: 0 })` job
     * would wedge its whole job class permanently, which is the opposite
     * of what a caller asking for the shortest possible lock means. Redis
     * meanwhile rejects `EX 0` outright, so the two stores disagreed about
     * it as well.
     */
    it("a zero-second TTL still expires rather than becoming a permanent lock", async () => {
      vi.useFakeTimers();
      try {
        const store = new ArrayCacheStore();
        const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 0 });
        await first.acquire();

        expect(await store.get("job_lock")).toBeDefined();

        vi.advanceTimersByTime(1_001);

        const second = new Lock(store, {
          key: "job",
          automaticReleaseAfterSeconds: 10,
          maximumWaitForSeconds: 0,
        });
        await expect(second.acquire()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("release() on a store with an atomic releaseLock()", () => {
    /**
     * The portable release is `get()` then `forget()`, two operations
     * with a window in between. On a store shared across processes, the
     * lock's TTL can expire inside that window, another holder can
     * acquire it, and the `forget()` then deletes *their* lock: two live
     * holders of a mutual-exclusion lock. A store that offers
     * `releaseLock()` closes the window, and `Lock` must actually use it.
     */
    it("prefers store.releaseLock() over get()-then-forget()", async () => {
      const store = new ArrayCacheStore();
      const releaseLock = vi.spyOn(store, "releaseLock");
      const forget = vi.spyOn(store, "forget");

      const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });
      await lock.acquire();
      await lock.release();

      expect(releaseLock).toHaveBeenCalledWith("job_lock", expect.any(String));
      expect(forget).not.toHaveBeenCalled();
      expect(await store.has("job_lock")).toBe(false);
    });

    it("falls back to get()-then-forget() on a store without one", async () => {
      const store = new ArrayCacheStore();
      // A store predating `releaseLock()`. It is optional on the
      // interface, so an out-of-package implementation may not have it
      // and the fallback must still release the lock.
      const withoutRelease: CacheStore = {
        get: (key) => store.get(key),
        put: (key, value, ttl) => store.put(key, value, ttl),
        forget: (key) => store.forget(key),
        has: (key) => store.has(key),
        flush: () => store.flush(),
        increment: (key, amount) => store.increment(key, amount),
        add: (key, value, ttl) => store.add(key, value, ttl),
        remember: (key, cb, ttl) => store.remember(key, cb, ttl),
        rememberViaLock: (key, cb, ttl) => store.rememberViaLock(key, cb, ttl),
        lock: (options) => store.lock(options),
      };
      expect(withoutRelease.releaseLock).toBeUndefined();

      const lock = new Lock(withoutRelease, { key: "job", automaticReleaseAfterSeconds: 10 });
      await lock.acquire();
      await lock.release();

      expect(await store.has("job_lock")).toBe(false);
    });
  });

  describe("get()", () => {
    it("acquires the lock, runs the callback, releases the lock, and returns the callback's result", async () => {
      const store = new ArrayCacheStore();
      const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

      const result = await lock.get(() => "computed");

      expect(result).toBe("computed");
      expect(await store.has("job_lock")).toBe(false);
    });

    it("still releases the lock if the callback throws", async () => {
      const store = new ArrayCacheStore();
      const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

      await expect(
        lock.get(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await store.has("job_lock")).toBe(false);
    });

    it("supports an async callback", async () => {
      const store = new ArrayCacheStore();
      const lock = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 10 });

      const result = await lock.get(async () => {
        await Promise.resolve();

        return 42;
      });

      expect(result).toBe(42);
    });
  });

  describe("automaticReleaseAfterSeconds", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("the lock is automatically released after automaticReleaseAfterSeconds elapses, even without release()", async () => {
      const store = new ArrayCacheStore();
      const first = new Lock(store, { key: "job", automaticReleaseAfterSeconds: 5 });
      await first.acquire();

      vi.advanceTimersByTime(5_001);

      const second = new Lock(store, {
        key: "job",
        automaticReleaseAfterSeconds: 5,
        maximumWaitForSeconds: 0,
      });
      await expect(second.acquire()).resolves.toBeUndefined();
    });
  });
});
