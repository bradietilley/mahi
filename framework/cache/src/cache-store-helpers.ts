import type { CacheStore } from "./cache-store.js";
import { Lock, type LockOptions } from "./locking/lock.js";
import { LockTimeoutError } from "./locking/lock-timeout-error.js";

/**
 * Shared implementations of `CacheStore.remember()`/`rememberViaLock()`/
 * `lock()`, built entirely on the five required primitives (`get`/`put`/
 * `forget`/`has`/`add`). Every `CacheStore` implementation can delegate
 * to these instead of re-deriving the same logic (see `ArrayCacheStore`/
 * `FileCacheStore`'s own `remember`/`rememberViaLock`/`lock` methods,
 * each a one-line call into here).
 */

/** Get-or-compute-and-store: returns the cached value if present, otherwise resolves, caches, and returns it. */
export async function remember<T>(
  store: CacheStore,
  key: string,
  callback: () => T | Promise<T>,
  ttlSeconds: number | null = null,
): Promise<T> {
  const value = await store.get<T>(key);

  if (value !== undefined) {
    return value;
  }

  const computed = await callback();
  await store.put(key, computed, ttlSeconds ?? undefined);

  return computed;
}

/**
/** Auto-release TTL and wait budget (seconds) for `rememberViaLock`'s lock. */
const REMEMBER_LOCK_TTL_SECONDS = 30;
const REMEMBER_LOCK_WAIT_SECONDS = 10;

/**
 * Like `remember()`, but guards the "compute and store" step with a
 * `Lock`, so under concurrent callers racing on the same missing key,
 * only one actually runs `callback()`; the rest wait for the lock, then
 * re-check the cache (now populated by the winner) before falling back to
 * running `callback()` themselves. Use this instead of plain `remember()`
 * when `callback` is expensive/side-effecting enough that running it
 * redundantly under a cache-miss stampede would be a real problem
 * (Laravel doesn't have a first-class equivalent. Closest is manually
 * pairing `Cache::lock()` with `remember()` yourself; this bakes that
 * pairing in as one call).
 *
 * The wait is BOUNDED (`REMEMBER_LOCK_WAIT_SECONDS`), not infinite. A lock
 * winner that crashes without releasing holds the lock until its TTL
 * (`REMEMBER_LOCK_TTL_SECONDS`) lapses; an unbounded waiter would then
 * block for that whole window before it could even re-check the cache,
 * turning one slow/dead computation into a fleet-wide stall. On timeout
 * the waiter re-checks the cache one last time and, if the value still
 * isn't there, computes it itself. That trades the strict single-flight
 * guarantee for liveness exactly when the lock can't be had. Which is the
 * behaviour this function's contract already promised.
 */
export async function rememberViaLock<T>(
  store: CacheStore,
  key: string,
  callback: () => T | Promise<T>,
  ttlSeconds: number | null = null,
  lockTiming: { ttlSeconds?: number; waitSeconds?: number } = {},
): Promise<T> {
  const value = await store.get<T>(key);

  if (value !== undefined) {
    return value;
  }

  const compute = async (): Promise<T> => {
    const computed = await callback();
    await store.put(key, computed, ttlSeconds ?? undefined);

    return computed;
  };

  const lockInstance = lock(store, {
    key,
    automaticReleaseAfterSeconds: lockTiming.ttlSeconds ?? REMEMBER_LOCK_TTL_SECONDS,
    maximumWaitForSeconds: lockTiming.waitSeconds ?? REMEMBER_LOCK_WAIT_SECONDS,
  });

  try {
    await lockInstance.acquire();
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) {
      throw error;
    }

    // Couldn't get the lock in time (a slow or crashed holder). Re-check
    // the cache, the winner may have finished, and otherwise compute it
    // ourselves rather than blocking indefinitely.
    const valueAfterWait = await store.get<T>(key);

    return valueAfterWait !== undefined ? valueAfterWait : compute();
  }

  try {
    // Re-check now that we hold the lock, another caller may have already
    // computed and stored the value while we were waiting.
    const valueAfterLock = await store.get<T>(key);

    if (valueAfterLock !== undefined) {
      return valueAfterLock;
    }

    return await compute();
  } finally {
    await lockInstance.release();
  }
}

/** Builds a `Lock` scoped to this `store`. */
export function lock(store: CacheStore, options: LockOptions): Lock {
  return new Lock(store, options);
}
