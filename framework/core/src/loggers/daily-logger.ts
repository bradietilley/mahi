import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { LogLevel, LogSource } from "../logger.js";
import { AbstractLogger, formatLogLine } from "../logger.js";

const DATE_SUFFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatDate(date: Date): string {
  // UTC, deliberately: line timestamps in `formatLogLine` are UTC
  // (`DateTime.now("UTC")`), so the file the lines land in must roll over
  // on the same clock — otherwise, on a machine offset from UTC, lines
  // written in the hours around local midnight get a UTC date that
  // disagrees with the local-date filename and end up in the "wrong"
  // day's file.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** e.g. `withDateSuffix("storage/logs/mahi.log", date)` -> `"storage/logs/mahi-2026-08-21.log"`. */
function withDateSuffix(path: string, date: Date): string {
  const ext = extname(path);
  const base = basename(path, ext);

  return join(dirname(path), `${base}-${formatDate(date)}${ext}`);
}

/**
 * Rotates to a new `{base}-{Y-m-d}{ext}` file each day — Laravel's "daily"
 * driver equivalent (`Monolog\Handler\RotatingFileHandler`). The
 * configured `path` (e.g. `storage_path('logs/mahi.log')`) is just the
 * template used to derive each day's actual filename; nothing is ever
 * written to that exact path.
 *
 * Rotation is driven by the current date at write time (not a timer) —
 * matches `RotatingFileHandler`'s "just compute today's filename" model,
 * so it works correctly across process restarts with no persisted state.
 * Pruning of files older than `maxFiles` days (if configured) only runs
 * when the target filename actually changes from the previous write, so a
 * burst of same-day log calls doesn't re-scan the directory every time.
 */
export class DailyLogger extends AbstractLogger {
  private lastResolvedPath: string | undefined;

  constructor(
    private path: string,
    private maxFiles?: number,
    private source?: LogSource,
  ) {
    super();
  }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const resolvedPath = withDateSuffix(this.path, new Date());
    const line = formatLogLine(level, message, context, this.source) + "\n";

    try {
      mkdirSync(dirname(resolvedPath), { recursive: true });
      appendFileSync(resolvedPath, line);
    } catch {
      // A log write must never throw into the caller (see FileLogger).
      // Fall back to stderr and skip rotation bookkeeping for this call.
      try {
        process.stderr.write(line);
      } catch {
        // Nothing left to do.
      }

      return;
    }

    if (resolvedPath !== this.lastResolvedPath) {
      this.lastResolvedPath = resolvedPath;

      // `maxFiles` unset OR <= 0 means "unlimited" — never prune. Guarding
      // `<= 0` is not pedantry: `slice(0)` returns the *entire* array, so
      // `maxFiles: 0` would delete every dated file including the one just
      // written. Monolog/Laravel treat `days => 0` as "keep everything".
      if (this.maxFiles !== undefined && this.maxFiles > 0) {
        this.prune(this.maxFiles);
      }
    }
  }

  /** Keeps only the `maxFiles` most recent dated log files, deleting the rest. */
  private prune(maxFiles: number): void {
    const dir = dirname(this.path);
    const ext = extname(this.path);
    const base = basename(this.path, ext);
    const pattern = new RegExp(
      `^${escapeRegExp(base)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(ext)}$`,
    );

    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }

    const dated = files
      .map((file) => {
        const match = pattern.exec(file);

        return match ? { file, date: match[1] as string } : null;
      })
      .filter(
        (entry): entry is { file: string; date: string } =>
          entry !== null && DATE_SUFFIX_PATTERN.test(entry.date),
      )
      .sort((a, b) => b.date.localeCompare(a.date));

    for (const { file } of dated.slice(maxFiles)) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // Best-effort — a file removed concurrently (or already gone) isn't an error here.
      }
    }
  }
}
