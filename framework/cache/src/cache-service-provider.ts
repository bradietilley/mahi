import { ServiceProvider, CACHE_TOKEN, storage_path } from "@mahiframework/core";
import { CacheManager, type CacheConfig } from "./cache-manager.js";
import { ArrayCacheStore } from "./stores/array-cache-store.js";
import { FileCacheStore } from "./stores/file-cache-store.js";
import { RateLimiter } from "./rate-limiting/rate-limiter.js";
import { CacheClearCommand } from "./commands/cache-clear.js";
import { CachePruneCommand } from "./commands/cache-prune.js";

// `CACHE_TOKEN`'s canonical definition lives in `@mahiframework/core`'s
// `well-known-tokens` (resolved cross-package by `@mahiframework/auth`'s
// "cache" session store); re-exported so this package's public API is
// unchanged.
export { CACHE_TOKEN };

/**
 * The container token the `RateLimiter` singleton is bound at.
 *
 * **Public.** It is exported from `index.ts` and resolved from other
 * packages (`@mahiframework/http`'s `throttle()` middleware) plus every generated
 * app's `app.provider.ts`, which registers its named limiters through it.
 * A token that consumers outside this package must name is public by
 * definition.
 */
export const RATE_LIMITER_TOKEN = "rate-limiter";

/** `stores.file` in `config/cache.ts`. */
interface FileCacheStoreConfig {
  /** Directory the per-key entry files live under. Defaults to `storage/cache`. */
  path?: string;
}

/** `stores.array` in `config/cache.ts`. */
interface ArrayCacheStoreConfig {
  /** See `ArrayCacheStoreOptions.sweepIntervalSeconds`. */
  sweepIntervalSeconds?: number;
}

/**
 * Registers the CacheManager singleton with the two built-in stores
 * ("array", "file") pre-registered via `extend()`, same mechanism a
 * plugin would use to add e.g. a "redis" store later. No `boot()` needed:
 * neither built-in store needs an async warm-up, same as `SqliteDriver`.
 *
 * `shutdown()` is a different matter. `ArrayCacheStore` runs a periodic
 * sweep timer, and a resolved store must be given the chance to stop it.
 *
 * Also registers the `RateLimiter` singleton, backed by the app's default
 * cache store, matches Laravel's own `Illuminate\Cache\
 * CacheServiceProvider`, which binds `RateLimiter::class` here rather
 * than in a separate provider (rate limiting is cache: counters with
 * TTLs). `@mahiframework/http`'s `throttle()` resolves this singleton via
 * `app().make(RATE_LIMITER_TOKEN)`, register `CacheServiceProvider`
 * before `HttpServiceProvider` in `config/app.ts`'s `providers[]`.
 */
export class CacheServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(CACHE_TOKEN, (app) => {
      const config = app.config.require<CacheConfig>("cache");
      const manager = new CacheManager(app, config);

      manager.extend("array", () => {
        const arrayConfig = (manager.storeConfig("array") ?? {}) as ArrayCacheStoreConfig;

        return new ArrayCacheStore({ sweepIntervalSeconds: arrayConfig.sweepIntervalSeconds });
      });

      manager.extend("file", () => {
        const fileConfig = (manager.storeConfig("file") ?? {}) as FileCacheStoreConfig;

        // A **directory**. `FileCacheStore` keeps one file per key. The
        // default is resolved here rather than being required in config
        // so an app that scaffolded before the layout change, or one that
        // omits the block entirely, still gets a working store.
        return new FileCacheStore(fileConfig.path ?? storage_path("cache"));
      });

      return manager;
    });

    this.app.singleton(RATE_LIMITER_TOKEN, (app) => {
      const manager = app.make<CacheManager>(CACHE_TOKEN);

      return new RateLimiter(manager.store());
    });
  }

  commands() {
    return [CacheClearCommand, CachePruneCommand];
  }

  /**
   * Tear down whatever stores were actually resolved.
   *
   * `isResolved` rather than `has`: on a shutdown following a failed
   * boot, `make()`ing the manager would construct a store purely to close
   * it. `disconnectAll()` then skips any store without a `disconnect()`,
   * so this is a no-op for every store but the array one, whose sweep
   * timer is `unref()`ed and therefore can't hang a process, but would
   * otherwise accumulate one live timer per `Application` built in a long
   * test run.
   */
  async shutdown(): Promise<void> {
    if (!this.app.isResolved(CACHE_TOKEN)) {
      return;
    }

    const manager = this.app.make<CacheManager>(CACHE_TOKEN);

    for (const error of await manager.disconnectAll()) {
      this.app.logger.error("cache: failed to shut down a store.", { error });
    }
  }
}
