import type { LogLevel } from "../logger.js";
import { AbstractLogger } from "../logger.js";

export interface ArrayLogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | undefined;
}

/**
 * Writes to an in-memory array instead of any real destination, Laravel's
 * "array" driver equivalent, handy for asserting on logged output in tests
 * without touching the filesystem. Entries are kept in call order and
 * never pruned; dies with the process like `ArrayCacheStore`.
 */
export class ArrayLogger extends AbstractLogger {
  readonly entries: ArrayLogEntry[] = [];

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level, message, context });
  }
}
