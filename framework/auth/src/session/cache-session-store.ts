import type { SessionRecord, SessionStore } from "./session-store.js";

/**
 * Minimal structural view of `@mahiframework/cache`'s `CacheStore` — the
 * operations this store actually needs.
 *
 * Structural rather than an import so `@mahiframework/auth` doesn't take a
 * package dependency on `@mahiframework/cache` for one optional store. The
 * concrete store is resolved at runtime via `CACHE_TOKEN`, the same
 * soft-dependency shape `@mahiframework/schedule` uses for `QUEUE_TOKEN`.
 */
export interface SessionCacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  forget(key: string): Promise<void>;
}

/**
 * Sessions in the cache, getting TTL-based expiry for free.
 *
 * Faster than the database store, with two real caveats worth knowing
 * before choosing it: sessions vanish on restart with the `array` store,
 * and `destroyForUser()` is unsupported because a cache can't be queried
 * by value — "log this user out everywhere" needs the database store.
 */
export class CacheSessionStore implements SessionStore {
  constructor(
    private readonly cache: SessionCacheStore,
    private readonly prefix = "session:",
  ) {}

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  async read(id: string): Promise<SessionRecord | null> {
    const record = await this.cache.get<SessionRecord>(this.key(id));

    if (record === undefined) {
      return null;
    }

    // The cache TTL should already have evicted this, but expiry is
    // enforced here too rather than trusted — same reasoning as the
    // database store, and it keeps both stores behaviourally identical.
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    return record;
  }

  async write(id: string, userId: string, expiresAt: string): Promise<void> {
    await this.cache.put<SessionRecord>(
      this.key(id),
      { id, userId, expiresAt },
      ttlSecondsUntil(expiresAt),
    );
  }

  async touch(id: string, expiresAt: string): Promise<void> {
    const existing = await this.read(id);

    if (existing === null) {
      return;
    }

    await this.cache.put<SessionRecord>(
      this.key(id),
      { ...existing, expiresAt },
      ttlSecondsUntil(expiresAt),
    );
  }

  async destroy(id: string): Promise<void> {
    await this.cache.forget(this.key(id));
  }

  async destroyForUser(): Promise<void> {
    throw new Error(
      "CacheSessionStore cannot revoke sessions by user — a cache can't be queried by value. " +
        "Use the 'database' session store if you need to log a user out everywhere.",
    );
  }

  async destroyForUserExcept(): Promise<void> {
    throw new Error(
      "CacheSessionStore cannot revoke sessions by user — a cache can't be queried by value. " +
        "Use the 'database' session store if you need to log a user out everywhere else.",
    );
  }

  /** No-op: the cache expires entries itself via the TTL set in `write()`. */
  async gc(): Promise<number> {
    return 0;
  }
}

function ttlSecondsUntil(expiresAt: string): number {
  const seconds = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);

  return Math.max(seconds, 1);
}
