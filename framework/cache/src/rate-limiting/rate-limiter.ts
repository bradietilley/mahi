import type { CacheStore } from "../cache-store.js";
import { Limit } from "./limit.js";

/**
 * `args` is untyped (`any[]`, not `unknown[]`). This package has zero
 * knowledge of what a consumer will pass at `limiter(name)`'s call site
 * (`@mahiframework/http`'s `throttle()` passes a Hono `Context`; a queue
 * consumer might pass a job payload). `unknown[]` would make a concretely
 * typed callback like `(c: Context) => Limit` fail TypeScript's
 * contravariant parameter-type check against this type. `any[]` is the
 * correct escape hatch here, matching `ResponseCallback`'s same rationale
 * in `limit.ts`.
 */
export type LimiterCallback = (...args: any[]) => Limit | Limit[] | Promise<Limit | Limit[]>;

/**
 * Cache-backed rate limiter, Laravel's `Illuminate\Cache\RateLimiter`
 * equivalent. Takes a `CacheStore` (from `CacheManager`) rather than
 * inventing a parallel counter-store abstraction: rate limiting **is**
 * cache, counters with TTLs, so it belongs on top of the same
 * `CacheStore` interface every other cached value uses, matching
 * Laravel's own architecture (`RateLimiter` takes a `Cache\Repository`).
 *
 * Two ways to use it:
 *
 * 1. **Manual**, for rate limiting outside HTTP entirely (a queued job, a
 *    login-attempt guard, ...), `hit()`/`tooManyAttempts()`/`attempts()`/
 *    `remaining()`/`clear()`/`availableIn()`/`attempt()`, operating
 *    directly on a plain string key.
 * 2. **Named limiters**, `for(name, callback)` registers a reusable
 *    limiter configuration (a callback returning one or several `Limit`s,
 *    given whatever arguments the caller passes to `limiter(name)`'s
 *    resolved closure), referenced by name from multiple call sites
 *    without redeclaring the limit inline each time. `@mahiframework/http`'s
 *    `throttle("name")` is the HTTP-specific consumer of this.
 */
export class RateLimiter {
  private limiters = new Map<string, LimiterCallback>();

  constructor(private cache: CacheStore) {}

  /** Register a named rate limiter configuration. */
  for(name: string, callback: LimiterCallback): this {
    this.limiters.set(name, callback);

    return this;
  }

  /**
   * Resolve a named limiter into a callback that, when invoked with
   * whatever arguments the caller has available (e.g. an HTTP `Context`),
   * returns the `Limit`(s) that callback produced, with duplicate `.key`s
   * across multiple `Limit`s from the same call resolved to each limit's
   * `fallbackKey()`, so two `Limit.perMinute()` calls with no explicit
   * `.by()` don't collide on the same counter. `undefined` if no limiter
   * is registered under `name`.
   */
  limiter(name: string): ((...args: any[]) => Promise<Limit[]>) | undefined {
    const registered = this.limiters.get(name);

    if (!registered) {
      return undefined;
    }

    return async (...args: any[]) => {
      const result = await registered(...args);
      const limits = Array.isArray(result) ? result : [result];

      const keyCounts = new Map<string, number>();

      for (const limit of limits) {
        keyCounts.set(limit.key, (keyCounts.get(limit.key) ?? 0) + 1);
      }

      const duplicateKeys = new Set(
        [...keyCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
      );

      if (duplicateKeys.size === 0) {
        return limits;
      }

      for (const limit of limits) {
        if (duplicateKeys.has(limit.key)) {
          limit.key = limit.fallbackKey();
        }
      }

      return limits;
    };
  }

  /**
   * Attempts to execute `callback` if `key` isn't currently rate-limited;
   * records a hit only if it runs. Returns `false` if rate-limited;
   * otherwise `callback`'s return value, or `true` if it returned
   * `undefined`/`null` (matches Laravel's `attempt()`, lets a
   * void-returning callback still signal "it ran" via a truthy result).
   */
  async attempt<T>(
    key: string,
    maxAttempts: number,
    callback: () => T | Promise<T>,
    decaySeconds = 60,
  ): Promise<T | true | false> {
    if (await this.tooManyAttempts(key, maxAttempts)) {
      return false;
    }

    const result = await callback();
    await this.hit(key, decaySeconds);

    return result ?? true;
  }

  /** True if `key` has already reached `maxAttempts` within its current (still-live) decay window. */
  async tooManyAttempts(key: string, maxAttempts: number): Promise<boolean> {
    if ((await this.attempts(key)) >= maxAttempts) {
      if (await this.cache.has(`${key}:timer`)) {
        return true;
      }

      await this.resetAttempts(key);
    }

    return false;
  }

  /** Increment (by 1) the counter for `key` for a given decay window. */
  async hit(key: string, decaySeconds = 60): Promise<number> {
    return this.increment(key, decaySeconds);
  }

  /**
   * Atomically record a hit and report whether `key` is now over its
   * limit, the race-free primitive a throttle should gate on.
   *
   * Reading `tooManyAttempts()` and then calling `hit()` as two steps lets
   * N concurrent requests all observe "under the limit" before any of them
   * increments, so the effective limit is exceeded under load, a real
   * TOCTOU on the framework's own abuse control. Because the underlying
   * store's `increment()` is atomic (a synchronous `Map` write, a locked
   * file RMW, or Redis `INCRBY`), incrementing FIRST and deciding on the
   * returned count closes that window: exactly one caller can be the one
   * that pushes the counter past `maxAttempts`.
   *
   * Returns the post-increment attempt count and whether it exceeds the
   * limit. The over-limit request has still been counted (matching
   * Laravel), which the window's TTL bounds.
   */
  async hitAndCheck(
    key: string,
    maxAttempts: number,
    decaySeconds = 60,
  ): Promise<{ hits: number; exceeded: boolean }> {
    const hits = await this.increment(key, decaySeconds);

    return { hits, exceeded: hits > maxAttempts };
  }

  /** Increment the counter for `key` for a given decay window by `amount`. */
  async increment(key: string, decaySeconds = 60, amount = 1): Promise<number> {
    // Seed the "when does this window reset" timer exactly once, the
    // first hit in a fresh window wins, subsequent hits within the same
    // window leave it untouched (`add()` is a no-op if already set).
    await this.cache.add(`${key}:timer`, this.availableAt(decaySeconds), decaySeconds);

    await this.cache.add(key, 0, decaySeconds);
    const hits = await this.cache.increment(key, amount);

    // Pin the window TTL whenever this call created the counter at its
    // floor (`hits === amount`). `increment()` preserves whatever expiry
    // the entry already had, correct for its own contract, but if the
    // counter had expired between the `add()` above and here (or the
    // `add()` seeded it and it then expired), `increment()` recreates it
    // with NO expiry on the array/file stores, and the counter would live
    // forever and lock the key out permanently. Re-asserting the TTL here,
    // unconditionally, not only when `add()` reported the key already
    // present, closes that window.
    if (hits === amount) {
      await this.cache.put(key, hits, decaySeconds);
    }

    return hits;
  }

  /** Decrement the counter for `key` for a given decay window by `amount`. */
  async decrement(key: string, decaySeconds = 60, amount = 1): Promise<number> {
    return this.increment(key, decaySeconds, amount * -1);
  }

  /** The number of attempts recorded for `key` so far in its current window. */
  async attempts(key: string): Promise<number> {
    return (await this.cache.get<number>(key)) ?? 0;
  }

  /** Clears the hit counter for `key` (but not its reset timer. See `clear()`). */
  async resetAttempts(key: string): Promise<void> {
    await this.cache.forget(key);
  }

  /** The number of attempts remaining for `key` before it hits `maxAttempts`. */
  async remaining(key: string, maxAttempts: number): Promise<number> {
    const attempts = await this.attempts(key);

    return Math.max(0, maxAttempts - attempts);
  }

  /** Alias for `remaining()`. */
  async retriesLeft(key: string, maxAttempts: number): Promise<number> {
    return this.remaining(key, maxAttempts);
  }

  /** Clears both the hit counter and reset timer for `key`, fully resetting it. */
  async clear(key: string): Promise<void> {
    await this.resetAttempts(key);
    await this.cache.forget(`${key}:timer`);
  }

  /** Seconds remaining until `key`'s current window resets and it becomes available again. */
  async availableIn(key: string): Promise<number> {
    const availableAt = (await this.cache.get<number>(`${key}:timer`)) ?? 0;

    return Math.max(0, availableAt - this.currentTime());
  }

  private currentTime(): number {
    return Math.floor(Date.now() / 1000);
  }

  private availableAt(delaySeconds: number): number {
    return this.currentTime() + delaySeconds;
  }
}
