import type { SnowflakeConfig } from "@mahiframework/snowflake";
import type { Env } from "./env.js";

/**
 * Snowflake ID generator. Opt in per model with `keyType: snowflake()`
 * in the model's config (see `src/models/user.model.ts`). This config
 * only takes effect once `SnowflakeServiceProvider` is registered (see
 * `config/app.ts`). The epoch and bit signature must not change after
 * IDs exist in the database.
 *
 * Prefer a unique `worker` per process so the default in-memory sequencer
 * is enough. Set `sequencing.resolver` to `"cache"` (Redis recommended)
 * or `"file"` only when processes share a worker id.
 */
export function snowflakeConfig(env: Env): SnowflakeConfig {
  return {
    testing: env.SNOWFLAKE_TESTING === "true",
    sequencing: {
      resolver: env.SNOWFLAKE_SEQUENCE_RESOLVER ?? null,
      store: env.SNOWFLAKE_CACHE_STORE,
      prefix: env.SNOWFLAKE_CACHE_PREFIX ?? "",
      file: env.SNOWFLAKE_SEQUENCE_FILE,
    },
    constants: {
      epoch: env.SNOWFLAKE_EPOCH ?? "2025-01-01 00:00:00",
      cluster: env.SNOWFLAKE_CLUSTER ?? 1,
      worker: env.SNOWFLAKE_WORKER ?? 1,
    },
  };
}
