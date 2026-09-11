/**
 * `@mahi/redis` — one shared Redis connection backing three thin
 * driver adapters: a `RedisCacheStore` (`CacheManager`), a
 * `RedisQueueDriver` (`QueueManager`), and a `RedisBroadcastDriver`
 * (`BroadcastManager`). This is the framework's multi-process production
 * story: shared cache across processes, cross-process broadcast fanout
 * (the fix for `LocalBroadcastDriver`'s silent single-process message
 * loss), and a faster queue backend.
 *
 * Add `RedisServiceProvider` to `config/app.ts`'s `providers[]` AFTER the
 * cache/queue/broadcasting providers, then point any of their `default`s
 * (or a named lookup) at `"redis"`. Merely listing the provider costs
 * nothing until a `redis` driver is actually resolved.
 */

export { RedisConnection } from "./redis-connection.js";
export type { RedisConnectionConfig } from "./redis-connection.js";

export { RedisManager } from "./redis-manager.js";
export type { RedisConfig } from "./redis-manager.js";

export { RedisCacheStore, DEFAULT_CACHE_PREFIX } from "./drivers/redis-cache-store.js";
export { RedisQueueDriver } from "./drivers/redis-queue-driver.js";
export {
  RedisBroadcastDriver,
  DEFAULT_BROADCAST_CHANNEL,
} from "./drivers/redis-broadcast-driver.js";

export { RedisServiceProvider, REDIS_TOKEN } from "./redis-service-provider.js";
