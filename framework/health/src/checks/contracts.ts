/**
 * Minimal structural types for the three managers the built-in checks
 * touch.
 *
 * **`@mahi/core` is this package's only dependency, and that is
 * load-bearing.** The checks reach `CacheManager`/`DatabaseManager`/
 * `StorageManager` through `CACHE_TOKEN`/`DATABASE_TOKEN`/`STORAGE_TOKEN`,
 * which live in core's `well-known-tokens.ts` precisely so a package can
 * resolve a service across a boundary without a compile-time edge to it.
 * Importing the real manager types here would reinstate exactly the edge
 * the tokens exist to avoid, and would make `@mahi/health` — and
 * therefore `./artisan health` — unusable in an app that hasn't installed
 * all three.
 *
 * These describe only the handful of members the checks call. They are
 * structurally satisfied by the real managers; if one of those signatures
 * changes incompatibly, the corresponding check's test (which runs
 * against the real `ArrayCacheStore`, a real sqlite `DatabaseManager`,
 * and a real `LocalStorageDriver`) fails.
 */

/** The slice of `CacheStore` `cacheCheck` uses. */
export interface CacheStoreLike {
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  forget(key: string): Promise<void>;
}

/** The slice of `CacheManager` `cacheCheck` uses. */
export interface CacheManagerLike {
  store(name?: string): CacheStoreLike;
}

/**
 * The slice of Kysely `databaseCheck` uses.
 *
 * `selectNoFrom` rather than the `sql` tagged template so this package
 * needs no `kysely` import at all — the compiled statement is the same
 * trivial `select 1`.
 */
export interface KyselyLike {
  selectNoFrom(callback: (eb: ExpressionBuilderLike) => unknown): {
    execute(): Promise<unknown>;
  };
}

export interface ExpressionBuilderLike {
  lit(value: number): { as(alias: string): unknown };
}

/** The slice of `DatabaseManager` `databaseCheck` uses. */
export interface DatabaseManagerLike {
  connection(name?: string): { kysely: KyselyLike };
}

/** The slice of `StorageDriver` `filesystemCheck` uses. */
export interface StorageDriverLike {
  put(path: string, contents: Buffer | string): Promise<void>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
}

/** The slice of `StorageManager` `filesystemCheck` uses. */
export interface StorageManagerLike {
  disk(name?: string): StorageDriverLike;
}
