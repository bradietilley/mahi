import { ServiceProvider, isConnectable } from "@mahiframework/core";
import { CacheManager, CACHE_TOKEN } from "@mahiframework/cache";
import { QueueManager, QUEUE_TOKEN } from "@mahiframework/queue";
import {
  BroadcastManager,
  BROADCAST_TOKEN,
  DEFAULT_SOCKET_PATH,
  resolveBroadcastDriverOptions,
} from "@mahiframework/broadcasting";
import { RedisManager, type RedisConfig } from "./redis-manager.js";
import { RedisConnection } from "./redis-connection.js";
import { RedisCacheStore, DEFAULT_CACHE_PREFIX } from "./drivers/redis-cache-store.js";
import { RedisQueueDriver } from "./drivers/redis-queue-driver.js";
import {
  RedisBroadcastDriver,
  DEFAULT_BROADCAST_CHANNEL,
} from "./drivers/redis-broadcast-driver.js";
import { REDIS_TOKEN } from "./tokens.js";

export { REDIS_TOKEN };

/** `stores.redis` in `config/cache.ts`. */
interface RedisCacheStoreConfig {
  connection?: string;
  /**
   * The cache's own namespace *within* the connection's `keyPrefix`.
   * Defaults to `DEFAULT_CACHE_PREFIX` (`"cache:"`), which is what keeps
   * `flush()` away from the queue's keys — see `RedisCacheStore`.
   *
   * This is not the connection's `keyPrefix`: that is read off the live
   * connection, and this one only ever names the sub-namespace.
   */
  prefix?: string;
}

/** `connections.redis` in `config/queue.ts`. */
interface RedisQueueConnectionConfig {
  connection?: string;
  queue?: string;
  /**
   * Seconds before a reserved job is presumed abandoned and reclaimed —
   * the crash-recovery window. Must exceed the longest a job can run.
   * Default 90.
   */
  retryAfter?: number;
}

/** `connections.redis` in `config/broadcasting.ts`. */
interface RedisBroadcastConnectionConfig {
  connection?: string;
  channel?: string;
  path?: string;
}

/**
 * Registers the shared `RedisManager` and wires a `redis` driver into
 * whichever of the three infra managers are present — `CacheManager`
 * (`"redis"` store), `QueueManager` (`"redis"` connection), and
 * `BroadcastManager` (`"redis"` connection) — via each manager's own
 * `extend()`. One `RedisConnection` backs all three, so the whole
 * multi-process story (shared cache, cross-process broadcast fanout, a
 * faster queue) comes from a single connection design and three thin
 * adapters.
 *
 * Ordering in `config/app.ts`'s `providers[]` (all hard requirements,
 * since each `extend()` resolves that manager's token):
 *   - after `CacheServiceProvider`, `QueueServiceProvider`, and
 *     `BroadcastServiceProvider` — their tokens must be bound before this
 *     provider's `register()` extends them;
 *   - before nothing new is required, but note `BroadcastServiceProvider`
 *     `boot()` mounts the websocket route for whatever driver is default,
 *     so as long as this provider's `register()` (which runs before ANY
 *     `boot()`) has extended the broadcast manager, `redis` is a valid
 *     `default` there.
 *
 * Only managers actually present are touched — an app without, say, the
 * queue package simply doesn't get a `redis` queue connection, no error.
 * The `redis` drivers are registered but never *resolved* unless config
 * points a `default` (or an explicit lookup) at them, so merely listing
 * this provider costs nothing until Redis is actually selected.
 */
export class RedisServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(REDIS_TOKEN, (app) => {
      const config = app.config.require<RedisConfig>("redis");
      const manager = new RedisManager(app, config);

      for (const name of manager.connectionNames()) {
        manager.extend(name, () => new RedisConnection(manager.connectionConfig(name)));
      }

      return manager;
    });

    this.extendCache();
    this.extendQueue();
    this.extendBroadcast();
  }

  async boot(): Promise<void> {
    // Only open a socket when something is actually pointed at Redis.
    //
    // Connecting unconditionally here contradicted this provider's own
    // contract ("merely listing this provider costs nothing until Redis
    // is actually selected") and had a concrete cost: an open ioredis
    // socket keeps the event loop alive, so every short-lived process
    // that boots the app — `./artisan migrate`, `key:generate`, any CLI
    // command, a test run — would hang after finishing its work instead
    // of exiting. The base app lists this provider by default so that
    // switching to Redis is a config change, which made "listed but
    // unused" the common case rather than the rare one.
    if (!this.redisIsSelected()) {
      return;
    }

    const redis = this.app.make<RedisManager>(REDIS_TOKEN);

    // Connect the default connection's primary client. Any additional
    // connection an app resolves by name is connected the same way by
    // whatever code resolves it, or here if you extend this loop.
    const connection = redis.connection();

    if (isConnectable(connection)) {
      await connection.connect();
    }

    // If broadcasting resolves to the Redis driver, start its pub/sub
    // subscriber now (it needs its own duplicated, connected client). A
    // no-op for any other broadcast driver.
    if (this.app.has(BROADCAST_TOKEN)) {
      const broadcaster = this.app.make<BroadcastManager>(BROADCAST_TOKEN);
      const driver = broadcaster.connection();

      if (driver instanceof RedisBroadcastDriver) {
        await driver.connect();
      }
    }
  }

  /**
   * Quit every Redis client this app opened — the exact mirror of
   * `boot()`, and the reason a `schedule:run` cron invocation with
   * `CACHE_STORE=redis` now exits instead of accumulating a zombie
   * process per minute: an open ioredis socket keeps Node's event loop
   * alive on its own.
   *
   * Order matters. The broadcast driver's subscriber is unsubscribed
   * first, because it was created through `RedisConnection.duplicate()`
   * and is therefore also tracked by the connection — quitting the
   * connection first would leave the driver quitting an already-closed
   * client. Both paths are individually best-effort anyway (see
   * `RedisConnection.disconnect()`), so the ordering is about clean logs,
   * not correctness.
   *
   * Every check here is `isResolved` rather than `has`: on a shutdown
   * following a failed boot, `make()`ing a manager that was never built
   * would construct a client purely to close it.
   */
  async shutdown(): Promise<void> {
    if (this.app.isResolved(BROADCAST_TOKEN)) {
      const broadcaster = this.app.make<BroadcastManager>(BROADCAST_TOKEN);

      for (const driver of broadcaster.resolvedDrivers()) {
        if (!(driver instanceof RedisBroadcastDriver)) {
          continue;
        }

        try {
          await driver.disconnect();
        } catch (error) {
          this.app.logger.error("redis: failed to stop the broadcast subscriber.", { error });
        }
      }
    }

    if (!this.app.isResolved(REDIS_TOKEN)) {
      return;
    }

    const redis = this.app.make<RedisManager>(REDIS_TOKEN);

    for (const error of await redis.disconnectAll()) {
      this.app.logger.error("redis: failed to quit a connection during shutdown.", { error });
    }
  }

  /**
   * Whether any of the three infra managers has `"redis"` as its *default*
   * driver.
   *
   * Deliberately a config read rather than resolving each manager's
   * driver: `Manager.driver()` would construct (and cache) a driver for
   * whatever the default is, which for `cache` means building a store on
   * every boot just to ask a question. An app that resolves a `redis`
   * driver by explicit name (`cache.store("redis")`) while defaulting to
   * something else connects lazily through that driver's own code path,
   * exactly as an extra named connection already does.
   */
  private redisIsSelected(): boolean {
    return (
      this.app.config.get<string>("cache.default") === "redis" ||
      this.app.config.get<string>("queue.default") === "redis" ||
      this.app.config.get<string>("broadcasting.default") === "redis"
    );
  }

  private extendCache(): void {
    if (!this.app.has(CACHE_TOKEN)) {
      return;
    }

    const cache = this.app.make<CacheManager>(CACHE_TOKEN);
    cache.extend("redis", (app) => {
      const config = (cache.storeConfig("redis") ?? {}) as RedisCacheStoreConfig;
      const redis = app.make<RedisManager>(REDIS_TOKEN);
      const connection = redis.connection(config.connection);

      return new RedisCacheStore(connection, config.prefix ?? DEFAULT_CACHE_PREFIX);
    });
  }

  private extendQueue(): void {
    if (!this.app.has(QUEUE_TOKEN)) {
      return;
    }

    const queue = this.app.make<QueueManager>(QUEUE_TOKEN);
    queue.extend("redis", (app) => {
      const config = (queue.connectionConfig("redis") ?? {}) as RedisQueueConnectionConfig;
      const redis = app.make<RedisManager>(REDIS_TOKEN);
      const connection = redis.connection(config.connection);

      return new RedisQueueDriver(connection, config.queue ?? "default", {
        retryAfterSeconds: config.retryAfter ?? 90,
        connectionName: "redis",
      });
    });
  }

  private extendBroadcast(): void {
    if (!this.app.has(BROADCAST_TOKEN)) {
      return;
    }

    const broadcast = this.app.make<BroadcastManager>(BROADCAST_TOKEN);
    broadcast.extend("redis", (app) => {
      const config = (broadcast.connectionConfig("redis") ?? {}) as RedisBroadcastConnectionConfig;
      const redis = app.make<RedisManager>(REDIS_TOKEN);
      const connection = redis.connection(config.connection);
      const path = config.path ?? DEFAULT_SOCKET_PATH;
      // Share the same channel-authorization + hardening options the local
      // driver uses (authorizer, origin allow-list, limits, logger), plus
      // the Redis-specific pub/sub channel name.
      const options = resolveBroadcastDriverOptions(app, path);

      return new RedisBroadcastDriver(connection, {
        ...options,
        channel: config.channel ?? DEFAULT_BROADCAST_CHANNEL,
      });
    });
  }
}
