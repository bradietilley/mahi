import { Manager } from "./manager.js";
import type { Application } from "./application.js";
import type { Logger } from "./logger.js";
import { FileLogger } from "./loggers/file-logger.js";
import { storage_path } from "./paths.js";

export type LogChannelConfig =
  | { driver: "console" }
  | { driver: "single"; path: string }
  | { driver: "daily"; path: string; maxFiles?: number }
  | { driver: "array" }
  | { driver: "null" }
  | { driver: "stack"; channels: string[] };

/**
 * A driver creator receives the resolving channel's *own* config (the
 * `channels[name]` entry) plus the manager, and returns a `Logger`. This
 * is what lets two channels share a driver — e.g. `app: { driver: "daily",
 * path: "…/app.log" }` and `audit: { driver: "daily", path: "…/audit.log" }`
 * both resolve the "daily" creator but with different config — which the
 * old `(app) => Logger` signature (one creator hard-coding
 * `channelConfig("daily")`) could not express.
 */
export type LogDriverCreator = (config: LogChannelConfig, manager: LogManager) => Logger;

export class LogChannelNotConfiguredError extends Error {
  constructor(channel: string) {
    super(`Log channel "${channel}" is not configured.`);
    this.name = "LogChannelNotConfiguredError";
  }
}

export class LogDriverNotRegisteredError extends Error {
  constructor(driver: string, channel: string) {
    super(`Log driver "${driver}" (channel "${channel}") is not registered.`);
    this.name = "LogDriverNotRegisteredError";
  }
}

export interface LogConfig {
  default: string;
  channels: Record<string, LogChannelConfig>;
  /**
   * Fallback used by `channel()` when resolving the requested (or
   * default) channel throws — an unregistered driver name, bad config, or
   * a driver's constructor itself failing (e.g. unwritable log
   * directory). Mirrors Laravel's top-level
   * `'emergency' => ['path' => storage_path('logs/laravel.log')]` config
   * key. Defaults to `storage_path("logs/mahi.log")` — the same physical
   * file the "single" channel writes to by default — if omitted.
   */
  emergency?: { path: string };
}

/**
 * Resolves named log "channels" (`Manager<Logger>`, same pattern as
 * `DatabaseManager`/`CacheManager`) — `"console"`, `"single"`, `"daily"`,
 * `"array"`, `"null"`, and `"stack"` (fan-out to other channels) are built
 * in via `LoggingServiceProvider`, mirroring Laravel's own driver set.
 *
 * This is a strictly additive, opt-in system living alongside
 * `Application.logger` (the always-available, unconfigurable
 * `ConsoleLogger` fallback) rather than replacing it: wiring
 * `Application.logger` itself through the container would introduce a
 * bootstrap-ordering hazard (logging that happens before
 * `LoggingServiceProvider.register()` runs during `bootstrap()`) for no
 * benefit. `app.logger` and `app.make(LOG_TOKEN).channel()` are
 * deliberately two different loggers unless explicitly configured to be
 * the same.
 */
export class LogManager extends Manager<Logger> {
  private emergencyLogger: Logger | undefined;

  /**
   * Driver creators keyed by **driver name** (`"single"`, `"daily"`, …),
   * *not* channel name. `channel(name)` looks up `channels[name].driver`
   * to pick the creator, then hands it that channel's own config — so any
   * number of distinctly-named channels can share one driver. This is a
   * separate registry from the base `Manager.creators` (which is keyed by
   * resolution name and unused here); resolved `Logger` instances are
   * still cached in `Manager.resolved` keyed by *channel* name.
   */
  private driverCreators = new Map<string, LogDriverCreator>();

  constructor(
    app: Application,
    private config: LogConfig | undefined,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    const name = this.config?.default;

    if (name === undefined) {
      // Thrown, not returned as undefined: `channel()` catches this inside
      // its guard and degrades to the emergency logger, which is the
      // documented behaviour for a missing `logging` config.
      throw new Error('No default log channel is configured ("logging.default").');
    }

    return name;
  }

  /**
   * Register a driver creator by **driver name** — the value channels
   * reference via their `driver` config key. Mirrors Laravel's
   * `LogManager::extend()`.
   */
  extendDriver(driver: string, creator: LogDriverCreator): this {
    this.driverCreators.set(driver, creator);

    return this;
  }

  /**
   * Resolve (and cache, per channel name) the `Logger` for a named
   * channel — or the default channel if no name is given.
   *
   * Unlike the base `Manager.driver()`, failures resolving the requested
   * channel (missing/invalid config, an unregistered *driver* the channel
   * asked for, or the driver's own constructor throwing — e.g. an
   * unwritable log directory) don't propagate: this falls back to the
   * "emergency" logger (see `LogConfig.emergency`) and logs the failure
   * through it, matching Laravel's `LogManager::get()` try/catch exactly —
   * so a misconfigured/broken log channel can't itself take down the
   * request that was trying to log through it.
   */
  channel(name?: string): Logger {
    // Compute the channel name *inside* the guard: reading the default
    // from a missing/undefined config must degrade to emergency too, not
    // throw before we even reach resolution.
    let channelName = name;
    try {
      channelName ??= this.getDefaultDriver();

      return this.resolveChannel(channelName);
    } catch (error) {
      const emergency = this.emergency();
      emergency.error("Unable to create configured logger. Using emergency logger.", {
        channel: channelName ?? "(default)",
        error: error instanceof Error ? error.message : String(error),
      });

      return emergency;
    }
  }

  private resolveChannel(channelName: string): Logger {
    if (this.resolved.has(channelName)) {
      return this.resolved.get(channelName) as Logger;
    }

    const channelConfig = this.config?.channels?.[channelName];

    if (!channelConfig) {
      throw new LogChannelNotConfiguredError(channelName);
    }

    const creator = this.driverCreators.get(channelConfig.driver);

    if (!creator) {
      throw new LogDriverNotRegisteredError(channelConfig.driver, channelName);
    }

    const logger = creator(channelConfig, this);
    this.resolved.set(channelName, logger);

    return logger;
  }

  channelConfig(name: string): LogChannelConfig | undefined {
    return this.config?.channels?.[name];
  }

  /**
   * The last-resort logger `channel()` falls back to when it can't
   * resolve the requested channel. Always a `FileLogger`, writing to
   * `LogConfig.emergency.path` (default `storage_path("logs/mahi.log")`)
   * — never itself resolved through `driver()`/`extend()`, so it can't
   * fail for the same reason the channel it's replacing just did. Lazily
   * constructed and cached, same as any other resolved driver.
   */
  emergency(): Logger {
    if (!this.emergencyLogger) {
      const path = this.config?.emergency?.path ?? storage_path("logs/mahi.log");
      this.emergencyLogger = new FileLogger(path, this.app);
    }

    return this.emergencyLogger;
  }
}
