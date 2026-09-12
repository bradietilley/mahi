import type { Redis } from "ioredis";
import type { CacheStore, Lock, LockOptions } from "@mahiframework/cache";
import { remember, rememberViaLock, lock } from "@mahiframework/cache";
import type { RedisConnection } from "../redis-connection.js";

/**
 * The namespace every key this store writes lives under, *within* the
 * connection's own `keyPrefix`. It cannot be configured away to `""`:
 * it is the boundary that makes `flush()` safe.
 *
 * `RedisQueueDriver` writes `queues:<name>`, `queues:<name>:reserved`,
 * `queues:<name>:delayed` and `queues:<name>:failed` on the *same*
 * connection, under the *same* `keyPrefix`. A cache `flush()` that
 * scanned the connection prefix alone would match all of them — so
 * `./artisan cache:clear` would delete every queued and every in-flight
 * job. Scoping cache keys under their own segment means the `flush()`
 * pattern (`<connection prefix>cache:*`) can never intersect
 * `<connection prefix>queues:*`, whatever the connection prefix is
 * (including empty).
 */
export const DEFAULT_CACHE_PREFIX = "cache:";

/**
 * A `CacheStore` backed by Redis — the multi-process-correct alternative
 * to `ArrayCacheStore` (dies with the process) and `FileCacheStore`
 * (correct, but only as correct as the filesystem it sits on). Because
 * `increment`/`add` map to Redis's genuinely atomic `INCRBY`/`SET NX`,
 * and `releaseLock` to a compare-and-delete Lua script, every
 * `RateLimiter`/`Lock` built on this store is correct *across* processes.
 *
 * Values are JSON-serialised on the way in and parsed on the way out, so
 * any JSON-representable value round-trips (matching `ArrayCacheStore`,
 * where `undefined` — never a stored value — is the "miss" sentinel).
 * `Date`/`Map`/`Set`/`BigInt` do NOT round-trip; see
 * `docs/cache/README.md`'s serialization table.
 *
 * ## Two prefixes, and why
 *
 * Every key this store touches is stored at
 * `<connection keyPrefix><store prefix><key>`:
 *
 *   - the **connection** prefix (`config/redis.ts`'s `keyPrefix`, e.g.
 *     `"mahi:"`) namespaces one *application* on a shared Redis, and is
 *     applied by ioredis itself to every command — which is why no method
 *     here ever mentions it, except `flush()` (see below);
 *   - the **store** prefix (`DEFAULT_CACHE_PREFIX`, overridable via
 *     `config/cache.ts`'s `stores.redis.prefix`) namespaces the *cache*
 *     apart from the queue and anything else sharing that connection, and
 *     is applied here, explicitly, by `prefixed()`.
 *
 * `flush()` is the one place the two must not be conflated. It scans and
 * deletes with the connection prefix read off `client.options`, never a
 * separately-configured copy of it: a stale or empty copy would scan
 * `MATCH *` (every key in the logical DB, including the queue) and then
 * `DEL` each match with the connection prefix applied a second time —
 * matching everything and deleting nothing.
 */
export class RedisCacheStore implements CacheStore {
  private readonly client: Redis;
  /** The connection-level prefix ioredis applies to every command, read off the live client. */
  private readonly connectionPrefix: string;

  constructor(
    private readonly connection: RedisConnection,
    /**
     * This store's own namespace *inside* the connection's `keyPrefix`.
     * Defaults to `DEFAULT_CACHE_PREFIX`; pass a different one only to
     * run two independent caches on one connection. Passing `""` is
     * allowed but re-opens the "flush() can reach the queue" hazard, so
     * don't.
     */
    private readonly prefix: string = DEFAULT_CACHE_PREFIX,
  ) {
    this.client = connection.client();
    this.connectionPrefix = connection.keyPrefix();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefixed(key));

    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (ttlSeconds !== undefined) {
      // `EX` is whole seconds; round up so a sub-second TTL never floors
      // to 0 (which Redis rejects as an invalid expire).
      await this.client.set(
        this.prefixed(key),
        serialized,
        "EX",
        Math.max(1, Math.ceil(ttlSeconds)),
      );
    } else {
      await this.client.set(this.prefixed(key), serialized);
    }
  }

  async forget(key: string): Promise<void> {
    await this.client.del(this.prefixed(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(this.prefixed(key))) === 1;
  }

  /**
   * Deletes every key under this store's namespace, and nothing else.
   *
   * Deliberately NOT `FLUSHDB`, which would nuke every other app sharing
   * the Redis instance/logical DB — and not a scan
   * of the connection prefix either, which would take the queue with it
   * (see `DEFAULT_CACHE_PREFIX`). The pattern is
   * `<connection prefix><store prefix>*`, so `queues:*` is out of reach
   * by construction rather than by convention.
   *
   * Iterates with `SCAN` (cursor-based, non-blocking — unlike `KEYS`,
   * which blocks the whole server for the length of the scan) and deletes
   * each batch with `UNLINK`, which frees the memory on a background
   * thread instead of stalling the server proportionally to how much
   * there was to free.
   *
   * `SCAN`'s `MATCH` pattern is the one place a prefix must be handled by
   * hand: it is matched against the *stored* key, which already includes
   * ioredis's `keyPrefix`, and ioredis does not prefix the pattern for
   * you. The keys `SCAN` returns are likewise fully-qualified, so the
   * connection prefix is stripped back off before `UNLINK` — otherwise
   * ioredis would apply it a second time and the delete would silently
   * match nothing. That double-prefix bug is exactly what made this
   * method a no-op on the shipped template config.
   */
  async flush(): Promise<void> {
    const pattern = `${this.connectionPrefix}${this.prefix}*`;
    let cursor = "0";

    do {
      const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;

      if (keys.length > 0) {
        await this.client.unlink(...keys.map((key) => this.stripConnectionPrefix(key)));
      }
    } while (cursor !== "0");
  }

  /**
   * Atomic via Redis `INCRBY`. Preserves any existing TTL (Redis keeps a
   * key's expiry across `INCRBY`), matching `ArrayCacheStore.increment()`'s
   * "incrementing shouldn't extend the window" semantics that
   * `RateLimiter` depends on. The counter is stored as a bare integer
   * string (not JSON) so `INCRBY` operates on it directly.
   *
   * Incrementing a key holding a non-numeric value rejects with Redis's
   * own `ERR value is not an integer or out of range`; the array and file
   * stores raise their own equivalent rather than coercing (`"5" + 1`
   * would otherwise become `"51"`).
   */
  async increment(key: string, amount = 1): Promise<number> {
    return this.client.incrby(this.prefixed(key), amount);
  }

  /**
   * Atomic via `SET key value NX EX ttl` — the single round-trip
   * "set only if absent" primitive `Lock.acquire()` is built on, now
   * genuinely exclusive *across processes*. Returns `true` iff this call
   * set the key.
   */
  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const serialized = JSON.stringify(value);
    const result =
      ttlSeconds !== undefined
        ? await this.client.set(
            this.prefixed(key),
            serialized,
            "EX",
            Math.max(1, Math.ceil(ttlSeconds)),
            "NX",
          )
        : await this.client.set(this.prefixed(key), serialized, "NX");

    // ioredis returns "OK" when the SET happened, `null` when NX blocked it.
    return result === "OK";
  }

  /**
   * Compare-and-delete in one server round-trip, via the canonical
   * Redlock release script — the atomic path `Lock.release()` uses when a
   * store offers one.
   *
   * `Lock.release()`'s portable fallback is `get()` then `forget()`, and
   * on a shared store those are two round-trips with a window in between.
   * If the lock's TTL expires inside that window and another holder
   * acquires it, the first holder's `forget()` deletes a lock it no
   * longer owns — two holders, which is the one thing a lock exists to
   * prevent. `EVAL` closes the window: Redis runs the script to
   * completion without interleaving another client's commands.
   *
   * `KEYS[1]` (not a concatenated key inside the script body) so the
   * script stays cluster-correct: Redis routes an `EVAL` by its declared
   * keys, and ioredis applies `keyPrefix` to declared keys exactly as it
   * does for any other command.
   */
  async releaseLock(key: string, owner: string): Promise<boolean> {
    const released = await this.client.eval(
      RELEASE_LOCK_LUA,
      1,
      this.prefixed(key),
      JSON.stringify(owner),
    );

    return released === 1;
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

  /** This store's namespace applied; the connection's is applied by ioredis on top. */
  private prefixed(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Undo ioredis's automatic prefixing for a key that came back from `SCAN`, which does not get it applied again. */
  private stripConnectionPrefix(key: string): string {
    return this.connectionPrefix && key.startsWith(this.connectionPrefix)
      ? key.slice(this.connectionPrefix.length)
      : key;
  }
}

/**
 * KEYS[1] = the lock key, ARGV[1] = the JSON-encoded owner token.
 * Deletes the key only if it still holds this owner's token; returns 1 if
 * it did, 0 otherwise. The owner is JSON-encoded because `add()` stores
 * values as JSON, so the stored bytes for owner `"abc"` are `"abc"` with
 * the quotes.
 */
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
