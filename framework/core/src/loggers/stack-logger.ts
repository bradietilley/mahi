import type { Logger, LogLevel } from "../logger.js";
import { AbstractLogger } from "../logger.js";

/**
 * A `Logger` that fans out every call to a list of other `Logger`s,
 * matches Laravel's `stack` driver concept: log to console AND file (or
 * any other combination of channels) simultaneously by resolving a
 * `"stack"` channel whose config lists the constituent channel names (see
 * `LogManager`/`LoggingServiceProvider`).
 *
 * Fans out via each constituent's own `log(level, …)`, so all eight PSR-3
 * levels reach every channel with a single `write()`.
 */
export class StackLogger extends AbstractLogger {
  constructor(private loggers: Logger[]) {
    super();
  }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.log(level, message, context);
    }
  }
}
