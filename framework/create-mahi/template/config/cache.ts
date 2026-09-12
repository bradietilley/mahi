import type { CacheConfig } from "@mahiframework/cache";
import type { Env } from "./env.js";

export function cacheConfig(env: Env): CacheConfig {
  return {
    default: env.CACHE_STORE,
    stores: {
      // In this process's memory. Fast, zero-setup, and shared with
      // nothing — two Node processes have two separate caches. Expired
      // entries are swept every `sweepIntervalSeconds` (default 60) so a
      // long-running server doesn't accumulate dead rate-limit counters.
      array: {},

      // One file per key under a directory (NOT a single JSON file —
      // `path` is a directory). Survives restarts and is safe for several
      // processes on the same host to share: writes are temp-file +
      // rename, and `add()` is an atomic `O_EXCL` create, so cross-process
      // `Lock`/`WithoutOverlapping` actually work. Local filesystems only
      // — those guarantees do not hold over NFS.
      //
      // Expiry is lazy, so schedule `cache:prune` if you write far more
      // keys than you read back.
      file: { path: "storage/cache" },

      // Multi-process-shared store. Requires @mahiframework/redis's
      // RedisServiceProvider to be registered; point `default` here when
      // running more than one Node process, or more than one host.
      //
      // `connection` omitted = the `default` Redis connection from
      // config/redis.ts. `prefix` (default "cache:") is the namespace
      // WITHIN that connection's keyPrefix that this store owns — it is
      // what keeps `cache:clear` from reaching the queue's `queues:*`
      // keys on the same connection. Change it only to run two
      // independent caches on one connection.
      redis: {},
    },
  };
}
