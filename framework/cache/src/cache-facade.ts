import { Facade } from "@mahi/facades";
import { CACHE_TOKEN } from "@mahi/core";
import type { CacheManager } from "./cache-manager.js";
import type { CacheStore } from "./cache-store.js";
import type { Lock, LockOptions } from "./locking/lock.js";

/**
 * Thin facade over the `CacheManager` singleton bound at `CACHE_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<CacheManager>(CACHE_TOKEN).store().get(...)`.
 *
 *   await Cache.put("key", value, 60);
 *   const value = await Cache.get<T>("key");
 *   const users = await Cache.remember("users", () => loadUsers(), 300);
 *   Cache.store("redis").put("key", value);       // a specific store
 *
 * `store()`/`remember()`/`rememberViaLock()` come from the `CacheManager`
 * itself; the plain operations (`get`/`put`/`forget`/`has`/`flush`/
 * `increment`/`add`/`lock`) are forwarded to the DEFAULT store — the
 * common case — matching how Laravel's `Cache` facade proxies to the
 * default repository. For a non-default store, go through `Cache.store
 * (name)` (a `CacheStore`) and call the same methods on it.
 *
 * Prefer constructor-injecting `CacheManager` (via `CACHE_TOKEN`) where
 * that's practical (e.g. inside a `ServiceProvider`/`Command` that already
 * receives `app`) — reach for this only where threading
 * `app`/`CacheManager` through is genuinely inconvenient, same guidance as
 * `app()` itself.
 */
export class Cache extends Facade<CacheManager>(() => CACHE_TOKEN) {
  /** The named store (default if omitted). Laravel's `Cache::store()`. */
  static store(name?: string): CacheStore {
    return this.instance().store(name);
  }

  static get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store().get<T>(key);
  }

  static put<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.store().put<T>(key, value, ttlSeconds);
  }

  static forget(key: string): Promise<void> {
    return this.store().forget(key);
  }

  static has(key: string): Promise<boolean> {
    return this.store().has(key);
  }

  static flush(): Promise<void> {
    return this.store().flush();
  }

  static increment(key: string, amount?: number): Promise<number> {
    return this.store().increment(key, amount);
  }

  static add<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    return this.store().add<T>(key, value, ttlSeconds);
  }

  static lock(options: LockOptions): Lock {
    return this.store().lock(options);
  }

  /**
   * Get-or-compute-and-store on the named (or default) store. See
   * `CacheManager.remember()`.
   */
  static remember<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
    storeName?: string,
  ): Promise<T> {
    return this.instance().remember(key, callback, ttlSeconds, storeName);
  }

  /** Stampede-safe `remember()`. See `CacheManager.rememberViaLock()`. */
  static rememberViaLock<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
    storeName?: string,
  ): Promise<T> {
    return this.instance().rememberViaLock(key, callback, ttlSeconds, storeName);
  }
}
