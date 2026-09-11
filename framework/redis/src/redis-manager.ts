import { Manager, type Application } from "@mahi/core";
import { RedisConnection, type RedisConnectionConfig } from "./redis-connection.js";

export interface RedisConfig {
  default: string;
  connections: Record<string, RedisConnectionConfig>;
}

/**
 * Resolves named `RedisConnection`s, synchronously, exactly like
 * `DatabaseManager`/`CacheManager`. One resolved connection is shared by
 * all three Redis-backed drivers (`RedisCacheStore`, `RedisQueueDriver`,
 * `RedisBroadcastDriver`) that point at the same connection name — a
 * single client design, three thin adapters. Each
 * connection is a `Connectable`; `RedisServiceProvider` connects the
 * default one in its `boot()` and disconnects every resolved connection on
 * shutdown.
 *
 * Built-in connections are registered via `extend()` by
 * `RedisServiceProvider`, same mechanism a plugin uses to add its own.
 */
export class RedisManager extends Manager<RedisConnection> {
  constructor(
    app: Application,
    private config: RedisConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /** Domain-flavored alias for `driver()`, mirroring `DatabaseManager.connection()`. */
  connection(name?: string): RedisConnection {
    return this.driver(name);
  }

  connectionConfig(name: string): RedisConnectionConfig {
    return this.config.connections[name] ?? {};
  }

  /** Names of every connection registered on this manager (config-declared). */
  connectionNames(): string[] {
    return Object.keys(this.config.connections);
  }
}
