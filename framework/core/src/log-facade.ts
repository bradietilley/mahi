import { app } from "./global-app.js";
import type { LogManager } from "./log-manager.js";
import { LOG_TOKEN } from "./logging-service-provider.js";
import type { Logger, LogLevel } from "./logger.js";

/**
 * Thin facade over the `LogManager` singleton bound at `LOG_TOKEN`, for
 * call sites that would otherwise read
 * `app().make<LogManager>(LOG_TOKEN).channel(...)`. Matches Laravel's
 * `Illuminate\Support\Facades\Log`.
 *
 *   Log.info("using the default channel");
 *   Log.channel("daily").warning("only goes to the daily-rotated file");
 *   const logger = Log.channel("custom"); // Logger
 *   logger.info("...");
 *
 * `LoggingServiceProvider` must be registered (like any other provider)
 * for `LOG_TOKEN` to resolve — see its docstring for why it's opt-in
 * rather than always-on.
 *
 * Hand-written directly against `app()`/`LOG_TOKEN` rather than built on
 * `@mahiframework/facades`' `Facade<T>(getFacadeKey)` mixin (the pattern
 * every other facade in this framework uses — `Events`, `Bus`, `Crypt`,
 * `Hash`, `Gate`, `Auth`) because `@mahiframework/facades` itself depends on
 * `@mahiframework/core` (for `app()`); `LOG_TOKEN`/`LogManager` live in
 * `@mahiframework/core` itself, so importing `Facade` from
 * `@mahiframework/facades` here would create a circular package dependency
 * (`core -> facades -> core`). `LogManager` is a concrete (non-generic)
 * type in this file, so there's no need for `Facade<T>`'s generic-static
 * workaround anyway — `instance()` below is exactly what
 * `Facade<LogManager>(() => LOG_TOKEN)` would have produced.
 *
 * Prefer constructor-injecting `LogManager` (via `LOG_TOKEN`) where that's
 * practical (e.g. inside a `ServiceProvider`/`Command` that already
 * receives `app`) — reach for this only at call sites where threading
 * `app`/`LogManager` through is genuinely inconvenient, same guidance as
 * `app()` itself. Same test-suite caveat as every other facade: this
 * always resolves off the *current* global `app()`, so tests that
 * construct their own isolated `Application` should resolve `LOG_TOKEN`
 * off that instance directly instead of using `Log`.
 */
export class Log {
  static instance(): LogManager {
    return app().make<LogManager>(LOG_TOKEN);
  }

  /** Domain-flavored alias for `instance()`, mirroring `LogManager.channel()` itself. */
  static channel(name?: string): Logger {
    return this.instance().channel(name);
  }

  static emergency(message: string, context?: Record<string, unknown>): void {
    this.channel().emergency(message, context);
  }

  static alert(message: string, context?: Record<string, unknown>): void {
    this.channel().alert(message, context);
  }

  static critical(message: string, context?: Record<string, unknown>): void {
    this.channel().critical(message, context);
  }

  static error(message: string, context?: Record<string, unknown>): void {
    this.channel().error(message, context);
  }

  static warning(message: string, context?: Record<string, unknown>): void {
    this.channel().warning(message, context);
  }

  static notice(message: string, context?: Record<string, unknown>): void {
    this.channel().notice(message, context);
  }

  static info(message: string, context?: Record<string, unknown>): void {
    this.channel().info(message, context);
  }

  static debug(message: string, context?: Record<string, unknown>): void {
    this.channel().debug(message, context);
  }

  /** Log at a runtime-chosen level — PSR-3/Laravel's `Log::log()`. */
  static log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.channel().log(level, message, context);
  }
}
