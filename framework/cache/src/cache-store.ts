import type { Lock, LockOptions } from "./locking/lock.js";

/**
 * Minimal cache backend contract, covering the operations that cover the
 * large majority of real usage: `get`/`put` (set with optional TTL)/
 * `forget` (delete)/`has`/`flush`, plus `increment`/`add` (the atomic
 * primitives `RateLimiter` and `Lock` are built on) and `remember`/
 * `rememberViaLock`/`lock` (shared methods every implementation gets by
 * delegating to `cache-store-helpers.ts`. See each built-in
 * store's own one-line implementations). Matches Laravel's `Illuminate\
 * Contracts\Cache\Repository` + `LockProvider` combined, minus tags
 * (a deliberate non-goal for the first pass).
 *
 * `ttlSeconds` optional/undefined on `put()` = no expiry (stays until
 * `forget`/`flush`, or process restart for `ArrayCacheStore`).
 */
export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  forget(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  flush(): Promise<void>;

  /**
   * Atomically increments a numeric counter, creating it at `0 + amount`
   * if it doesn't exist yet. Used by `RateLimiter`/`throttle()` for
   * hit-counting, a plain `get` + `put` round-trip would race under
   * concurrent requests hitting the same key, so implementations must
   * make this a single atomic operation (see `ArrayCacheStore.increment
   * ()`'s docstring for exactly what "atomic" requires and why a naive
   * `await`-split implementation is NOT atomic despite looking
   * correct. This is a real bug class, not a theoretical one; a future
   * Redis-backed store would use `INCRBY`).
   */
  increment(key: string, amount?: number): Promise<number>;

  /**
   * Sets `key` to `value` only if it doesn't already exist (or has
   * expired), used by `RateLimiter` to seed a rate-limit window's expiry
   * exactly once, and by `Lock.acquire()` as its core "acquire" primitive
   * (a lock IS just `add()` on a `"<key>_lock"` entry). Returns `true` if
   * the key was set by this call, `false` if it already existed. Same
   * atomicity requirement as `increment()`. See above.
   */
  add<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;

  /**
   * Atomically delete `key`, but only if it currently holds `owner`,
   * the store-native "release this lock" primitive `Lock.release()`
   * prefers when a store provides it. Returns `true` if this call deleted
   * the key.
   *
   * **Optional.** A store that omits it gets `Lock.release()`'s portable
   * fallback: `get()` the key, compare, then `forget()` it. That fallback
   * is correct on a store whose operations can't interleave with another
   * process's (`ArrayCacheStore`, `FileCacheStore`. See their
   * atomicity docstrings), and *not* correct on a shared one: the lock's
   * TTL can expire between the `get()` and the `forget()`, another holder
   * can acquire it in that window, and the `forget()` then deletes a lock
   * this instance no longer owns. Two live holders of a mutual-exclusion
   * lock, which is the single failure a lock exists to prevent.
   *
   * So: implement this on any store shared across processes.
   * `RedisCacheStore` does, with a compare-and-delete Lua script.
   */
  releaseLock?(key: string, owner: string): Promise<boolean>;

  /**
   * Eagerly drop every entry whose TTL has already elapsed, returning how
   * many were removed.
   *
   * **Optional**, and only meaningful for a store that expires lazily,
   * i.e. one that evaluates `expiresAt` when something *reads* a key, and
   * therefore never reclaims a key nothing reads again. `RateLimiter` is
   * the case that makes this matter rather than theoretical: it writes
   * `throttle:<name>:<ip>` and `:timer` for every distinct client and
   * never reads them once the window has passed, so a long-running
   * process accumulates two dead entries per IP it has ever seen.
   *
   * `ArrayCacheStore` implements it (and calls it on a timer of its own);
   * `FileCacheStore` implements it as a directory walk, for
   * `./artisan cache:prune` or a scheduled task. `RedisCacheStore` does
   * **not**, and shouldn't: Redis expires keys itself, both lazily and
   * via an active background cycle.
   */
  prune?(): number | Promise<number>;

  /**
   * Get-or-compute-and-store: returns the cached value if present,
   * otherwise runs `callback`, stores its result under `key` (with
   * `ttlSeconds`, or no expiry if `null`), and returns it. `ttlSeconds`
   * defaults to `null` (no expiry), pass a number for a bounded cache
   * lifetime.
   */
  remember<T>(key: string, callback: () => T | Promise<T>, ttlSeconds?: number | null): Promise<T>;

  /**
   * Like `remember()`, but guards the compute-and-store step with a
   * `Lock` so a cache-miss stampede (many concurrent callers all missing
   * the same key at once) only runs `callback()` once. See
   * `cache-store-helpers.ts`'s `rememberViaLock()` for the full
   * "check → lock → re-check → compute" sequence.
   */
  rememberViaLock<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds?: number | null,
  ): Promise<T>;

  /**
   * Builds a `Lock` scoped to this store. See `Lock`'s own docstring for
   * `acquire()`/`release()`/`get()` semantics and `LockOptions` for
   * `key`/`automaticReleaseAfterSeconds`/`maximumWaitForSeconds`/`retryEvery`. Not
   * every conceivable `CacheStore` implementation necessarily provides
   * genuinely exclusive locking (see `Lock`'s docstring on what
   * `add()`'s atomicity guarantee actually requires). Both built-in
   * stores do.
   */
  lock(options: LockOptions): Lock;
}
