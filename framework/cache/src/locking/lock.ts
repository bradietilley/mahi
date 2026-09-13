import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CacheStore } from "../cache-store.js";
import { LockTimeoutError } from "./lock-timeout-error.js";

export interface LockOptions {
  /**
   * The lock's key within the owning `CacheStore`, automatically
   * suffixed with `_lock` (e.g. `key: "todos:rebuild"` locks under
   * `"todos:rebuild_lock"`) so it can never collide with a plain cached
   * value stored under the same base key, which matters for
   * `rememberViaLock()` locking around a `remember()` call on that exact
   * key.
   */
  key: string;
  /**
   * How long (in **seconds**) the lock is held before it's automatically
   * released, even if `release()` is never called, a safety net against
   * a crashed/hung holder leaving the lock stuck forever. Implemented as
   * the underlying `CacheStore` entry's TTL, which also takes seconds,
   * so the units line up. Matches Laravel's
   * `Cache::lock($name, $seconds)`.
   */
  automaticReleaseAfterSeconds: number;
  /**
   * How long (in **seconds**) `acquire()` will keep retrying before
   * giving up and throwing `LockTimeoutError`. Defaults to
   * `Number.POSITIVE_INFINITY`, wait indefinitely (retrying every
   * `retryEvery` ms) until acquired. Pass a finite value to bound the
   * wait instead. Matches Laravel's `block($seconds)`.
   *
   * `maximumWaitForSeconds: 0` = try once, throw immediately if held.
   */
  maximumWaitForSeconds?: number;
  /** Milliseconds to sleep between retry attempts while waiting. Defaults to 250ms. */
  retryEvery?: number;
}

/**
 * A mutual-exclusion lock backed by a `CacheStore`'s atomic `add()` (see
 * `CacheStore.add()`'s docstring. This is exactly the "set only if
 * absent" primitive a lock needs). How exclusive a `Lock` actually is
 * depends on how atomic the underlying store's `add()` really is: both
 * built-in stores (`ArrayCacheStore`, synchronous `Map` check-then-set,
 * `FileCacheStore`, a serialized write queue) are atomic within a
 * single Node.js process. A store shared *across* processes needs two
 * things for a `Lock` on it to be safe there: a genuinely atomic
 * `SETNX`-style `add()`, and an atomic compare-and-delete
 * `releaseLock()` (see `CacheStore.releaseLock()` for why the portable
 * `get`-then-`forget` release is not enough once another process can
 * interleave). `RedisCacheStore` has both.
 *
 * Deliberately more explicit than Laravel's `Cache::lock()` (no implicit
 * "owner" identity string to manage yourself, no separate `block()`/
 * `get()` methods with different waiting semantics), one `acquire()`
 * that always waits up to `maximumWaitForSeconds` (default: indefinitely) and
 * always throws `LockTimeoutError` on timeout, one `release()`, and a
 * `get(callback)` convenience wrapping both:
 *
 *   const lock = cache.lock({ key: "rebuild-index", automaticReleaseAfterSeconds: 30, maximumWaitForSeconds: 5 });
 *   await lock.acquire();       // throws LockTimeoutError if not acquired within 5s
 *   try {
 *     await rebuildIndex();
 *   } finally {
 *     await lock.release();
 *   }
 *
 *   // equivalent, via get():
 *   await lock.get(() => rebuildIndex());
 */
export class Lock {
  private readonly lockKey: string;
  private readonly owner = randomUUID();
  /** Auto-release TTL in seconds, what `CacheStore.add()` takes directly. */
  private readonly automaticReleaseAfterSeconds: number;
  /** Maximum wait budget in **milliseconds** (the retry loop works in ms). */
  private readonly maximumWaitForMs: number;
  private readonly retryEvery: number;
  private held = false;

  constructor(
    private readonly store: CacheStore,
    private readonly options: LockOptions,
  ) {
    this.lockKey = `${options.key}_lock`;

    // Guarded at runtime as well as in the type: a lock with no TTL never
    // expires, so a crashed holder would wedge the key forever.
    if (options.automaticReleaseAfterSeconds === undefined) {
      throw new Error(
        "Lock requires an automatic-release TTL: pass `automaticReleaseAfterSeconds` (seconds).",
      );
    }

    this.automaticReleaseAfterSeconds = options.automaticReleaseAfterSeconds;
    this.maximumWaitForMs =
      options.maximumWaitForSeconds !== undefined
        ? options.maximumWaitForSeconds * 1000
        : Number.POSITIVE_INFINITY;

    this.retryEvery = options.retryEvery ?? 250;
  }

  /**
   * Blocks until the lock is acquired or the maximum wait budget elapses.
   * Throws `LockTimeoutError` on timeout. Safe to call again after a
   * timeout (retries from scratch).
   */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.maximumWaitForMs;
    // Floor of 1 second. `Math.ceil()` alone turns a TTL of `0` (or a
    // negative one) into `0`, which every store reads as "no expiry" on
    // `put`/`add`, except Redis, which rejects `EX 0` outright. Neither
    // is what a caller asking for a zero-length lock means, and the
    // permanent-lock reading is the dangerous one: a `WithoutOverlapping`
    // job configured with `expireAfterSeconds: 0` would wedge that job
    // class forever, with no TTL to recover it. One second is the
    // shortest lifetime Redis can express, so it is the floor everywhere.
    const ttlSeconds = Math.max(1, Math.ceil(this.automaticReleaseAfterSeconds));

    while (true) {
      const acquired = await this.store.add(this.lockKey, this.owner, ttlSeconds);

      if (acquired) {
        this.held = true;

        return;
      }

      if (Date.now() >= deadline) {
        throw new LockTimeoutError(this.options.key);
      }

      const remaining = deadline - Date.now();
      await sleep(
        Number.isFinite(remaining)
          ? Math.min(this.retryEvery, Math.max(0, remaining))
          : this.retryEvery,
      );
    }
  }

  /**
   * Releases the lock, but only if this `Lock` instance is the one
   * currently holding it (checked via its random `owner` token), a
   * `release()` call after the lock has already expired and been
   * re-acquired by someone else is a safe no-op, not an accidental
   * release of a lock this instance no longer owns.
   *
   * Two implementations, and which one runs is up to the store:
   *
   *   - **`store.releaseLock(key, owner)`** when the store has it, one
   *     atomic compare-and-delete. This is the correct path on any store
   *     shared across processes, and `RedisCacheStore` provides it.
   *   - **`get()` then `forget()`** otherwise. Correct on a store whose
   *     operations can't interleave with another process's, which the
   *     two built-in stores' are, and *not* correct on one that can:
   *     the TTL can expire between the two calls, a second holder can
   *     acquire the lock in that window, and the `forget()` then deletes
   *     *their* lock. That is why `CacheStore.releaseLock()` exists.
   */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }

    this.held = false;

    if (this.store.releaseLock) {
      await this.store.releaseLock(this.lockKey, this.owner);

      return;
    }

    const currentOwner = await this.store.get<string>(this.lockKey);

    if (currentOwner === this.owner) {
      await this.store.forget(this.lockKey);
    }
  }

  /**
   * Release the lock **unconditionally**, regardless of which instance or
   * process acquired it and without an owner check, Laravel's
   * `Lock::forceRelease()`. This is the cross-process release path a
   * unique job needs: the lock is acquired in the dispatching process and
   * released in whichever worker later finishes the job, so there is no
   * shared `owner` token and no `held` flag to consult, the worker
   * reconstructs the lock from the same key and clears it by name.
   *
   * The tradeoff (same as Laravel): if the lock's TTL expired mid-job and
   * a concurrent dispatch acquired a *fresh* lock under the same key, this
   * release clears that new lock too. `uniqueFor` is the knob that makes
   * that vanishingly unlikely, set it comfortably above the job's
   * worst-case runtime.
   */
  async forceRelease(): Promise<void> {
    this.held = false;
    await this.store.forget(this.lockKey);
  }

  /** Acquires the lock, runs `callback`, then releases the lock (even if `callback` throws). Returns `callback`'s result. */
  async get<T>(callback: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await callback();
    } finally {
      await this.release();
    }
  }
}
