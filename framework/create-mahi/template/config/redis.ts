import type { RedisConfig } from "@mahiframework/redis";
import type { Env } from "./env.js";

/**
 * Redis connections shared by the `redis` cache store, queue connection,
 * and broadcast driver. Registering `RedisServiceProvider` and declaring a
 * connection here costs nothing until something actually resolves a
 * `redis` driver — the cache/queue/broadcasting configs keep their
 * in-process defaults (`array`/`sync`/`local`) unless you point their
 * `default` at `"redis"`, which is the switch to flip when scaling to more
 * than one Node process.
 *
 * A per-app `keyPrefix` is set so the cache store's `flush()` only clears
 * this app's keys, never a co-tenant's, on a shared Redis instance — see
 * `RedisCacheStore.flush()`.
 */
export function redisConfig(env: Env): RedisConfig {
  return {
    default: "default",
    connections: {
      default: {
        url: env.REDIS_URL,
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
        keyPrefix: "mahi:",
      },
    },
  };
}
