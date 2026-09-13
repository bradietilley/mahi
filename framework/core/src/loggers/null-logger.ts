import type { LogLevel } from "../logger.js";
import { AbstractLogger } from "../logger.js";

/**
 * Writes nothing, Laravel's "null" driver equivalent
 * (`Monolog\Handler\NullHandler`). Useful for silencing a channel (e.g.
 * pointing `LOG_DEPRECATIONS_CHANNEL` at it) without special-casing call
 * sites that just call `logger.debug(...)` unconditionally.
 */
export class NullLogger extends AbstractLogger {
  protected write(_level: LogLevel, _message: string, _context?: Record<string, unknown>): void {}
}
