import { describe, expect, it } from "vitest";
import {
  CacheScheduleLocker,
  type LockingCacheStore,
} from "../../src/locking/cache-schedule-locker.js";

const MINUTE_MS = 60_000;

/**
 * A minimal store with a genuinely atomic `add()`, synchronous
 * check-then-set on a `Map`, which within one process is exactly the
 * guarantee `CacheScheduleLocker` requires (and what `ArrayCacheStore`
 * provides). TTLs are recorded rather than enforced; the tests that care
 * assert on what was passed.
 */
class FakeStore implements LockingCacheStore {
  readonly entries = new Map<string, unknown>();
  readonly ttls: Array<{ key: string; ttlSeconds: number | undefined }> = [];

  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    this.ttls.push({ key, ttlSeconds });

    if (this.entries.has(key)) {
      return false;
    }

    this.entries.set(key, value);

    return true;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async forget(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

describe("CacheScheduleLocker", () => {
  it("acquires a free key", async () => {
    const locker = new CacheScheduleLocker(new FakeStore());
    expect(await locker.acquire("k", MINUTE_MS)).toBe(true);
  });

  it("refuses a key another locker holds", async () => {
    const store = new FakeStore();
    const a = new CacheScheduleLocker(store);
    const b = new CacheScheduleLocker(store);

    expect(await a.acquire("k", MINUTE_MS)).toBe(true);
    expect(await b.acquire("k", MINUTE_MS)).toBe(false);
  });

  it("releases so the next locker can take it", async () => {
    const store = new FakeStore();
    const a = new CacheScheduleLocker(store);
    const b = new CacheScheduleLocker(store);

    await a.acquire("k", MINUTE_MS);
    await a.release("k");

    expect(await b.acquire("k", MINUTE_MS)).toBe(true);
  });

  it("locks are per-key", async () => {
    const store = new FakeStore();
    const locker = new CacheScheduleLocker(store);

    await locker.acquire("a", MINUTE_MS);
    expect(await locker.acquire("b", MINUTE_MS)).toBe(true);
  });

  it("suffixes the cache key with _lock so it cannot collide with a cached value", async () => {
    const store = new FakeStore();
    await new CacheScheduleLocker(store).acquire("schedule-overlap:nightly", MINUTE_MS);

    expect([...store.entries.keys()]).toEqual(["schedule-overlap:nightly_lock"]);
  });

  it("converts the expiry to whole seconds", async () => {
    const store = new FakeStore();
    await new CacheScheduleLocker(store).acquire("k", 90_000);

    expect(store.ttls[0]?.ttlSeconds).toBe(90);
  });

  it("never asks for a zero TTL, which many stores read as 'never expires'", async () => {
    const store = new FakeStore();
    await new CacheScheduleLocker(store).acquire("k", 10);

    expect(store.ttls[0]?.ttlSeconds).toBe(1);
  });

  describe("owner-checked release", () => {
    it("does not release a lock another locker now holds", async () => {
      // The scenario: A's task overran its expiry, the lock lapsed, B took
      // it, and only then did A's `finally` run. A must not delete B's lock.
      const store = new FakeStore();
      const a = new CacheScheduleLocker(store);
      const b = new CacheScheduleLocker(store);

      await a.acquire("k", MINUTE_MS);
      // Simulate the lock expiring out from under A.
      store.entries.delete("k_lock");
      await b.acquire("k", MINUTE_MS);

      await a.release("k");

      expect(store.entries.has("k_lock")).toBe(true);
    });

    it("release() on a key this locker never held is a no-op", async () => {
      const store = new FakeStore();
      await expect(new CacheScheduleLocker(store).release("k")).resolves.toBeUndefined();
    });

    it("uses the store's atomic releaseLock() when available and never touches another owner's lock", async () => {
      // A cross-process store (Redis) provides an atomic compare-and-delete.
      // The locker must prefer it over get()+forget(), and it must only
      // delete a lock whose owner token still matches.
      const releaseCalls: Array<{ key: string; owner: string }> = [];
      let forgetCalled = false;

      class AtomicStore implements LockingCacheStore {
        readonly entries = new Map<string, string>();
        async add<T>(key: string, value: T): Promise<boolean> {
          if (this.entries.has(key)) {
            return false;
          }

          this.entries.set(key, value as unknown as string);

          return true;
        }
        async get<T>(key: string): Promise<T | undefined> {
          return this.entries.get(key) as T | undefined;
        }
        async forget(key: string): Promise<void> {
          forgetCalled = true;
          this.entries.delete(key);
        }
        async releaseLock(key: string, owner: string): Promise<boolean> {
          releaseCalls.push({ key, owner });

          if (this.entries.get(key) !== owner) {
            return false;
          }

          this.entries.delete(key);

          return true;
        }
      }

      const store = new AtomicStore();
      const a = new CacheScheduleLocker(store);
      const b = new CacheScheduleLocker(store);

      await a.acquire("k", MINUTE_MS);
      // A lapses, B takes over.
      store.entries.delete("k_lock");
      await b.acquire("k", MINUTE_MS);

      await a.release("k");

      // Went through the atomic path, not get()/forget().
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0]?.key).toBe("k_lock");
      expect(forgetCalled).toBe(false);
      // B's lock survives.
      expect(store.entries.has("k_lock")).toBe(true);
    });
  });

  it("exactly one of many concurrent acquires wins", async () => {
    const store = new FakeStore();
    const lockers = Array.from({ length: 20 }, () => new CacheScheduleLocker(store));
    const results = await Promise.all(
      lockers.map((locker) => locker.acquire("contended", MINUTE_MS)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
