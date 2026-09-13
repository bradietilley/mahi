import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel, LogSource } from "../logger.js";
import { AbstractLogger, formatLogLine } from "../logger.js";

/**
 * Appends formatted lines to a file path from config, one of the built-in
 * `LogManager` channels. Reuses `formatLogLine()` so its output is
 * visually identical to `ConsoleLogger`'s.
 *
 * Synchronous `appendFileSync` deliberately, matches `better-sqlite3`'s
 * own "synchronous is fine, I/O is not the bottleneck here" philosophy
 * already established for the database driver, and avoids needing to make
 * every `Logger` method `async` (a wide-reaching API change every existing
 * `Logger` implementation and call site would need to absorb, not worth it
 * for log writes).
 *
 * No log rotation, appends to one growing file indefinitely. Real log
 * rotation (`logrotate`-style size/date-based rollover) is an operational
 * concern typically handled by the deployment environment, not application
 * code.
 */
export class FileLogger extends AbstractLogger {
  constructor(
    private path: string,
    private source?: LogSource,
  ) {
    super();
    // Best-effort at construction: if the directory can't be created
    // (unwritable/read-only mount) don't throw out of the constructor,
    // `write()` degrades to stderr below. A logger that can't be built
    // must not take down whatever was trying to construct it (in
    // particular the emergency logger, see `LogManager.channel`).
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // Deferred to write(), which falls back to stderr.
    }
  }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const line = formatLogLine(level, message, context, this.source) + "\n";
    try {
      appendFileSync(this.path, line);
    } catch (error) {
      // ENOSPC / EACCES / EROFS etc. A log write must never throw into
      // the caller. That would mask the very error being logged. Fall
      // back to stderr, itself guarded so a broken stderr can't throw
      // either.
      try {
        process.stderr.write(line);
      } catch {
        // Nothing left to do; swallow to honour "logging never throws".
      }
      void error;
    }
  }
}
