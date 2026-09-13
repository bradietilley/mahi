import { Manager, type Application } from "@mahiframework/core";
import type { CacheStore } from "./cache-store.js";

export interface CacheConfig {
  default: string;
  stores: Record<string, unknown>;
}

/**
 * Resolves named cache stores (`"array"`, `"file"`, later `"redis"`),
 * synchronously, exactly like `DatabaseManager`. Built-in stores are
 * registered via `extend()` by `CacheServiceProvider`, same mechanism a
 * plugin would use to add e.g. a `"redis"` store later.
 */
export class CacheManager extends Manager<CacheStore> {
  constructor(
    app: Application,
    private config: CacheConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /** Domain-flavored alias for `driver()`, mirroring `DatabaseManager.connection()`. */
  store(name?: string): CacheStore {
    return this.driver(name);
  }

  /**
   * Replace the resolved store for a name (default if omitted), bypassing
   * the configured factory and any cached instance, the cache analogue
   * of `QueueManager.swap()`. The test-only primitive behind
   * `createTestApplication({ fakeCache: true })`, which points the default
   * store at a fresh in-memory `ArrayCacheStore`; production code
   * configures stores through `config/cache.ts`.
   */
  swap(store: CacheStore, name?: string): void {
    this.resolved.set(name ?? this.getDefaultDriver(), store);
  }

  storeConfig(name: string): unknown {
    return this.config.stores[name];
  }

  /**
   * Get-or-compute-and-store on the named (or default) store, delegates
   * to `CacheStore.remember()` after resolving which store to use.
   * Argument order matches `CacheStore.remember()`'s
   * `(key, callback, ttlSeconds)` exactly; `storeName` is the one extra
   * parameter this convenience adds.
   */
  async remember<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
    storeName?: string,
  ): Promise<T> {
    return this.store(storeName).remember(key, callback, ttlSeconds);
  }

  /** Like `remember()`, but stampede-safe. See `CacheStore.rememberViaLock()`. */
  async rememberViaLock<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
    storeName?: string,
  ): Promise<T> {
    return this.store(storeName).rememberViaLock(key, callback, ttlSeconds);
  }
}
