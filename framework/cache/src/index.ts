export type { CacheStore } from "./cache-store.js";
export { ArrayCacheStore } from "./stores/array-cache-store.js";
export type { ArrayCacheStoreOptions } from "./stores/array-cache-store.js";
export { FileCacheStore } from "./stores/file-cache-store.js";
export { CacheManager } from "./cache-manager.js";
export type { CacheConfig } from "./cache-manager.js";
export { CacheServiceProvider, CACHE_TOKEN, RATE_LIMITER_TOKEN } from "./cache-service-provider.js";

export { Cache } from "./cache-facade.js";

export { CacheClearCommand } from "./commands/cache-clear.js";
export { CachePruneCommand } from "./commands/cache-prune.js";

// Shared CacheStore.remember()/rememberViaLock()/lock() implementations,
// exported so out-of-package CacheStore implementations (e.g.
// @mahiframework/redis's RedisCacheStore) can delegate to them exactly like
// the built-in array/file stores do, rather than re-deriving the logic.
export { remember, rememberViaLock, lock } from "./cache-store-helpers.js";

export { Lock } from "./locking/lock.js";
export type { LockOptions } from "./locking/lock.js";
export { LockTimeoutError } from "./locking/lock-timeout-error.js";

export { Limit, GlobalLimit, Unlimited } from "./rate-limiting/limit.js";
export type { AfterCallback, ResponseCallback } from "./rate-limiting/limit.js";
export { RateLimiter } from "./rate-limiting/rate-limiter.js";
export type { LimiterCallback } from "./rate-limiting/rate-limiter.js";
