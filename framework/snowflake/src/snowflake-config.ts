/**
 * Framework config for `@mahiframework/snowflake`. Apps typically build this
 * from env in `config/snowflake.ts` and `app.config.set("snowflake", …)`
 * before bootstrap, same as `cache` / `database`.
 */
export interface SnowflakeConfig {
  /**
   * When true, IDs are sequential `9000000000000000001`, `…002`, … grouped
   * by model class name — predictable in tests without giving up the
   * 19-digit JSON width of real snowflakes.
   */
  testing: boolean;

  sequencing: {
    /**
     * `"memory"` (default, in-process), `"file"` (lockfile), `"cache"`
     * (Redis-recommended `CacheStore.add`/`increment`), or `null` to
     * leave the core `MemorySequenceResolver` in place.
     */
    resolver: "memory" | "file" | "cache" | null;

    /** Cache store name used when `resolver` is `"cache"`. `undefined` = default store. */
    store?: string;

    /** Cache key prefix used when `resolver` is `"cache"`. */
    prefix: string;

    /** Sequence file path used when `resolver` is `"file"`. */
    file?: string;
  };

  constants: {
    /**
     * Starting epoch for all timestamps. A recent epoch keeps the
     * generator valid for ~35 years. Never change this after IDs exist.
     */
    epoch: string;
    /** Cluster id — must fit the configured cluster bit width (default 0–31). */
    cluster: number;
    /** Worker id within the cluster — must fit the worker bit width (default 0–31). */
    worker: number;
  };
}

export function defaultSnowflakeConfig(): SnowflakeConfig {
  return {
    testing: false,
    sequencing: {
      resolver: null,
      prefix: "",
    },
    constants: {
      epoch: "2025-01-01 00:00:00",
      cluster: 1,
      worker: 1,
    },
  };
}
