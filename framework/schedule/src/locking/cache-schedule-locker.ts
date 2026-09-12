import { randomUUID } from "node:crypto";
import type { ScheduleLocker } from "./schedule-locker.js";

/**
 * The slice of `@mahiframework/cache`'s `CacheStore` this locker needs. Declared
 * structurally, and resolved through the `"cache"` token at runtime, so
 * `@mahiframework/schedule` keeps its "no compile-time dependency on the packages
 * it can optionally use" property — the same arrangement `schedule.job()`
 * has with `@mahiframework/queue`.
 */
export interface LockingCacheStore {
  /** Set only if absent. MUST be atomic — this is the whole lock. */
  add<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  forget(key: string): Promise<void>;
  /**
   * Atomic owner-checked release (compare-and-delete). Optional: stores
   * shared across processes (Redis) provide it and MUST be used for a
   * correct release; stores whose operations can't interleave with another
   * process's fall back to `get()` + `forget()`. See `release()`.
   */
  releaseLock?(key: string, owner: string): Promise<boolean>;
}

/**
 * `withoutOverlapping()` backed by a cache store rather than lock files.
 *
 * The point is reach. A lock *file* is visible only to processes sharing a
 * filesystem, so two hosts each running `schedule:run` both take "the"
 * lock and both run the task. Point this at a store whose `add()` is
 * atomic across processes — Redis, whose `add()` is a `SET NX` — and the
 * lock becomes global, which is what makes running the scheduler on more
 * than one host safe. This is the backend `ScheduledTask.onOneServer()`
 * relies on; without a cross-process store that method degrades to
 * per-machine exclusion, which is no exclusion at all across hosts.
 *
 * That guarantee is only as good as the store's. `ArrayCacheStore` is
 * per-process and gives no cross-process exclusion at all, so
 * `runDueTasks()` refuses to use it and falls back to files rather than
 * silently pretending; `FileCacheStore` is exactly as machine-local as the
 * lock files it would replace.
 *
 * Release is owner-checked: the value stored is a token unique to this
 * locker instance, and `release()` deletes the entry only if the token
 * still matches. A task that overran its expiry — so the lock was
 * reclaimed by the next run — must not have its `finally` block delete the
 * *new* holder's lock.
 */
export class CacheScheduleLocker implements ScheduleLocker {
  /** Identifies locks taken by this instance, for owner-checked release. */
  private readonly owner = randomUUID();

  constructor(private readonly store: LockingCacheStore) {}

  /**
   * `_lock` suffix, matching `@mahiframework/cache`'s own `Lock`, so a schedule
   * lock can never collide with a plain cached value under the same key.
   */
  private cacheKey(key: string): string {
    return `${key}_lock`;
  }

  async acquire(key: string, expiresAfterMs: number): Promise<boolean> {
    // Round up: a sub-second expiry would floor to 0, which several stores
    // read as "no TTL" — a lock that never expires, i.e. a task that never
    // runs again after one crash.
    const ttlSeconds = Math.max(1, Math.ceil(expiresAfterMs / 1000));

    return this.store.add(this.cacheKey(key), this.owner, ttlSeconds);
  }

  async release(key: string): Promise<void> {
    const cacheKey = this.cacheKey(key);

    // Prefer the store's atomic compare-and-delete. On a cross-host store
    // (Redis — the whole reason this locker exists) a get()-then-forget()
    // has a window where the lock's TTL expires between the two calls, a
    // second host reacquires it, and the forget() then deletes THAT host's
    // lock — letting the task run twice. `releaseLock()` closes the window;
    // the get()/forget() fallback is only correct on a store whose
    // operations can't interleave across processes.
    if (this.store.releaseLock) {
      await this.store.releaseLock(cacheKey, this.owner);

      return;
    }

    const currentOwner = await this.store.get<string>(cacheKey);

    // Not ours (expired and retaken, or already gone) — leave it alone.
    if (currentOwner !== this.owner) {
      return;
    }

    await this.store.forget(cacheKey);
  }
}
