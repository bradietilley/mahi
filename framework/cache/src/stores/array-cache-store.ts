import type { CacheStore } from "../cache-store.js";
import { numericValue } from "./numeric-value.js";
import { remember, rememberViaLock, lock } from "../cache-store-helpers.js";
import type { Lock, LockOptions } from "../locking/lock.js";

interface Entry {
  value: unknown;
  expiresAt: number | undefined;
}

export interface ArrayCacheStoreOptions {
  /**
   * How often (seconds) to sweep expired entries out of memory. Defaults
   * to 60. Pass `0` to disable the sweep entirely — appropriate for a
   * short-lived process (a CLI command, a test) that will exit long
   * before anything accumulates.
   */
  sweepIntervalSeconds?: number;
}

/**
 * In-memory `CacheStore` — dies with the process, good for tests/dev and
 * the framework's single-process default. No setup required, matching the
 * "correct, zero-infra default" pattern used elsewhere in this codebase
 * (`SyncQueueDriver`, `LocalBroadcastDriver`).
 */
export class ArrayCacheStore implements CacheStore {
  private store = new Map<string, Entry>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(options: ArrayCacheStoreOptions = {}) {
    const intervalSeconds = options.sweepIntervalSeconds ?? 60;

    if (intervalSeconds > 0) {
      this.startSweeping(intervalSeconds);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.liveEntry(key)?.value as T | undefined;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async forget(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async flush(): Promise<void> {
    this.store.clear();
  }

  /**
   * Reads and writes to `this.store` (a plain `Map`) synchronously, with
   * no `await` between the check and the write — deliberately, so this
   * method is atomic across concurrent callers. `Map` operations
   * themselves are synchronous, and JavaScript's single-threaded,
   * run-to-completion semantics mean a synchronous block can't be
   * interrupted by another `async` caller's continuation — the moment
   * either method `await`s, its whole synchronous prefix has already
   * committed. Splitting the read and write across an `await` (e.g. `if
   * (await this.has(key)) ...; await this.put(key, ...)`) would NOT be
   * atomic — two concurrent callers could both observe "key absent"
   * before either has written, exactly the bug `Lock.acquire()` depends
   * on this method not having.
   *
   * Throws on a non-numeric existing value rather than coercing, so every
   * store agrees: Redis `INCRBY` rejects it, `FileCacheStore` rejects it,
   * and silently producing `"5" + 1 === "51"` here would make a bug
   * visible only under one `CACHE_STORE`.
   */
  async increment(key: string, amount = 1): Promise<number> {
    const existing = this.liveEntry(key);
    const current = numericValue("ArrayCacheStore", key, existing?.value);
    const next = current + amount;
    // Preserve the existing entry's expiry rather than resetting it —
    // matches Laravel's increment() semantics (the TTL was already seeded
    // by a prior `add()` call; incrementing shouldn't extend it).
    this.store.set(key, { value: next, expiresAt: existing?.expiresAt });

    return next;
  }

  /** See `increment()`'s docstring — synchronous check-then-write, no `await` in between, for atomicity. */
  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    if (this.liveEntry(key) !== undefined) {
      return false;
    }

    this.store.set(key, {
      value,
      expiresAt: ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : undefined,
    });

    return true;
  }

  /**
   * Compare-and-delete, synchronously — no `await` between the read and
   * the delete, so it is atomic for the same reason `add()` is. Only
   * meaningful within this process, which is all this store spans.
   */
  async releaseLock(key: string, owner: string): Promise<boolean> {
    if (this.liveEntry(key)?.value !== owner) {
      return false;
    }

    this.store.delete(key);

    return true;
  }

  /**
   * Drops every entry whose TTL has elapsed. Returns how many it removed.
   *
   * Expiry is otherwise evaluated lazily, on read — which is enough for a
   * key space that is read back, and a leak for one that isn't.
   * `RateLimiter` is the case that bites: `throttle:<name>:<ip>` and its
   * `:timer` sibling are written for every distinct client and, once the
   * window passes, never read again. In a long-running server that is two
   * permanent `Map` entries per IP ever seen — an unbounded leak whose
   * rate is set by your traffic's client diversity. The periodic sweep
   * (see the constructor) calls this; it is public so a test or an app
   * can force one.
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && entry.expiresAt < now) {
        this.store.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * How many entries are resident, **including ones that have expired
   * but not yet been reclaimed** — which is the number that matters when
   * the question is "is this store leaking?", and the reason it isn't
   * filtered. `prune()` is what makes it drop.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Stops the sweep timer. Called by `CacheManager.disconnectAll()` at
   * shutdown via the `Connectable` teardown half, so a terminated
   * application leaves no timer behind — which matters most in tests,
   * where many `Application`s are built and torn down in one process.
   *
   * The timer is `unref()`ed anyway, so it can never be the reason a
   * process fails to exit; this is about not accumulating them.
   */
  async disconnect(): Promise<void> {
    if (this.sweeper === undefined) {
      return;
    }

    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private startSweeping(intervalSeconds: number): void {
    this.sweeper = setInterval(() => this.prune(), intervalSeconds * 1000);
    // Without `unref()` this timer alone would keep Node's event loop
    // alive, so every `./artisan` command would hang after doing its
    // work — the exact failure the Redis provider's conditional connect
    // exists to avoid. An unref'd timer still fires while the process has
    // other reasons to live, which is precisely when a sweep is wanted.
    this.sweeper.unref?.();
  }

  /** Synchronous read of a still-live (non-expired) entry, lazily deleting it if it has expired. */
  private liveEntry(key: string): Entry | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      this.store.delete(key);

      return undefined;
    }

    return entry;
  }

  async remember<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
  ): Promise<T> {
    return remember(this, key, callback, ttlSeconds);
  }

  async rememberViaLock<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
  ): Promise<T> {
    return rememberViaLock(this, key, callback, ttlSeconds);
  }

  lock(options: LockOptions): Lock {
    return lock(this, options);
  }
}
