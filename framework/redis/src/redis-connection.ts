import { Redis, type RedisOptions } from "ioredis";
import type { Connectable } from "@mahi/core";

/**
 * Per-connection configuration. Either give a `url` (`redis://[:password@]
 * host:port[/db]`, or `rediss://…` for TLS) or the discrete `host`/`port`/
 * `password`/`db` fields — `url` wins if both are present. `keyPrefix` is
 * applied by ioredis to every key on this connection, which is the
 * cleanest way to give one shared Redis server per-app namespacing (see
 * `RedisCacheStore.flush()`'s docstring for why that matters). `options`
 * is an escape hatch straight through to ioredis for anything not modelled
 * here (`tls`, `sentinels`, `retryStrategy`, …).
 */
export interface RedisConnectionConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  keyPrefix?: string;
  options?: RedisOptions;
}

/**
 * Owns one logical Redis connection — a single command client plus,
 * lazily, any *dedicated* clients that a caller needs because Redis puts a
 * connection into a mode where it can't also serve normal commands:
 *
 *   - a client in **subscriber mode** (`SUBSCRIBE`) can only run
 *     (un)subscribe/ping commands until it unsubscribes, so
 *     `RedisBroadcastDriver` gets its own subscriber via `duplicate()`;
 *   - a **blocking** command (`BRPOP`) monopolises its connection for the
 *     whole block, so `RedisQueueDriver`'s blocking pop gets its own
 *     client too, leaving the main one free for `push`/`LPUSH`.
 *
 * Everything non-blocking and non-subscribed (`GET`/`SET`/`INCR`/`PUBLISH`/
 * `LPUSH`/`LREM`/…) shares the single `client()`. Implements `Connectable`
 * so its owning provider connects it explicitly in `boot()` and
 * disconnects every client it handed out on shutdown, following the
 * sync-driver-resolution + `Connectable` philosophy — this is exactly the
 * driver that legitimately needs an async `connect()` step.
 */
export class RedisConnection implements Connectable {
  private readonly options: RedisOptions;
  private readonly primary: Redis;
  private readonly duplicates: Redis[] = [];

  constructor(config: RedisConnectionConfig = {}) {
    this.options = buildOptions(config);
    // `lazyConnect` keeps `new Redis()` from opening a socket eagerly —
    // resolution stays synchronous (a driver handle is cheap to
    // construct), and the actual connect happens in `connect()`, matching
    // how `SqliteDriver` defers real I/O.
    this.primary = new Redis(this.options);
  }

  /** The shared command client for all non-blocking, non-subscribed work. */
  client(): Redis {
    return this.primary;
  }

  /**
   * The prefix ioredis prepends to every key on this connection (`""`
   * when none is configured).
   *
   * Read it from here rather than re-deriving it from config. ioredis
   * applies the prefix automatically to command *keys*, but not to a
   * `SCAN`/`KEYS` `MATCH` pattern, and not to a pub/sub channel — so the
   * handful of places that need to construct a fully-qualified key by
   * hand (`RedisCacheStore.flush()`, `RedisBroadcastDriver`'s channel
   * name) need the real, effective value. Taking it from `client()
   * .options` rather than from a separate config read is what stops the
   * two drifting: a store told a different prefix than the connection
   * actually uses produces a `flush()` that matches everything and
   * deletes nothing, which is precisely the bug this accessor exists to
   * make unrepresentable.
   */
  keyPrefix(): string {
    return this.primary.options.keyPrefix ?? "";
  }

  /**
   * A brand-new client with the *same* options, tracked so `disconnect()`
   * tears it down too. Callers use this for the two modes a shared client
   * can't be in — subscriber mode and blocking reads (see class docstring).
   */
  duplicate(): Redis {
    const client = this.primary.duplicate();
    this.duplicates.push(client);

    return client;
  }

  async connect(): Promise<void> {
    // With `lazyConnect`, `connect()` resolves once the socket is ready
    // (or rejects on failure). A client that's already connecting/ready
    // throws "Redis is already connecting/connected" — treat that as a
    // no-op so a double-`connect()` (e.g. two providers sharing one
    // connection) is harmless.
    await ignoreAlreadyConnected(this.primary.connect());
  }

  async disconnect(): Promise<void> {
    // `quit()` flushes pending commands then closes; fall back to a hard
    // `disconnect()` if the client never connected (quit would hang).
    await Promise.all([this.primary, ...this.duplicates].map((client) => quit(client)));
    this.duplicates.length = 0;
  }
}

function buildOptions(config: RedisConnectionConfig): RedisOptions {
  const base: RedisOptions = { lazyConnect: true, ...config.options };

  if (config.url) {
    const parsed = parseRedisUrl(config.url);
    Object.assign(base, parsed);
  } else {
    if (config.host !== undefined) {
      base.host = config.host;
    }

    if (config.port !== undefined) {
      base.port = config.port;
    }

    if (config.username !== undefined) {
      base.username = config.username;
    }

    if (config.password !== undefined) {
      base.password = config.password;
    }

    if (config.db !== undefined) {
      base.db = config.db;
    }
  }

  if (config.keyPrefix !== undefined) {
    base.keyPrefix = config.keyPrefix;
  }

  return base;
}

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const options: RedisOptions = {};

  if (parsed.hostname) {
    options.host = parsed.hostname;
  }

  if (parsed.port) {
    options.port = Number(parsed.port);
  }

  if (parsed.username) {
    options.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }

  const path = parsed.pathname.replace(/^\//, "");

  if (path) {
    options.db = Number(path);
  }

  if (parsed.protocol === "rediss:") {
    options.tls = {};
  }

  return options;
}

async function ignoreAlreadyConnected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("already connecting") || message.includes("already connected")) {
      return;
    }

    throw error;
  }
}

async function quit(client: Redis): Promise<void> {
  try {
    if (client.status === "ready" || client.status === "connect") {
      await client.quit();
    } else {
      client.disconnect();
    }
  } catch {
    // A best-effort shutdown must never throw — the process is going down
    // regardless, and a failed quit shouldn't mask the real exit reason.
    client.disconnect();
  }
}
