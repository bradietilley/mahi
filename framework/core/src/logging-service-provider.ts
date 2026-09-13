import { ServiceProvider } from "./service-provider.js";
import { ConsoleLogger } from "./logger.js";
import { LogManager, type LogConfig, type LogChannelConfig } from "./log-manager.js";
import { FileLogger } from "./loggers/file-logger.js";
import { DailyLogger } from "./loggers/daily-logger.js";
import { ArrayLogger } from "./loggers/array-logger.js";
import { NullLogger } from "./loggers/null-logger.js";
import { StackLogger } from "./loggers/stack-logger.js";

export const LOG_TOKEN = "log";

/**
 * Registers the `LogManager` singleton with the built-in channel drivers
 * ("console", "single", "daily", "array", "null", "stack") pre-registered
 * via `extend()`, same mechanism a plugin would use to add e.g. a
 * "sentry" channel later. No `boot()` needed, none of the built-in
 * channels need async warm-up.
 *
 * Driver names/semantics mirror Laravel's `config/logging.php` channels
 * directly: "single" writes to one fixed file, "daily" rotates to a new
 * dated file each day, "array" collects entries in memory (tests), "null"
 * discards everything, and "stack" fans out to other named channels.
 *
 * Lives in `@mahiframework/core` (not a downstream package) since `Logger`
 * itself is core, and this is a natural extension of it, but, unlike
 * every other provider in this framework, is NOT registered implicitly:
 * an app must explicitly add `LoggingServiceProvider` to `providers[]`
 * like any other provider (consistent with there being no implicit
 * provider registration anywhere else in this framework, and with keeping
 * `Application.logger` as the always-available zero-config fallback.
 * See `LogManager`'s docstring for the full "these are two different
 * loggers" design decision).
 */
export class LoggingServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(LOG_TOKEN, (app) => {
      const config = app.config.get<LogConfig>("logging");
      const manager = new LogManager(app, config);

      // Creators are keyed by *driver* name and receive the resolving
      // channel's own config, so any number of channels can share a
      // driver (two "daily" channels writing to two different files, etc).
      manager.extendDriver("console", () => new ConsoleLogger(app));
      manager.extendDriver("single", (cfg) => {
        const { path } = cfg as Extract<LogChannelConfig, { driver: "single" }>;

        return new FileLogger(path, app);
      });
      manager.extendDriver("daily", (cfg) => {
        const { path, maxFiles } = cfg as Extract<LogChannelConfig, { driver: "daily" }>;

        return new DailyLogger(path, maxFiles, app);
      });
      manager.extendDriver("array", () => new ArrayLogger());
      manager.extendDriver("null", () => new NullLogger());
      manager.extendDriver("stack", (cfg, mgr) => {
        const { channels } = cfg as Extract<LogChannelConfig, { driver: "stack" }>;

        return new StackLogger(channels.map((name) => mgr.channel(name)));
      });

      return manager;
    });
  }
}
