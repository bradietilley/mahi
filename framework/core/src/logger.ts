import { DateTime } from "@mahiframework/datetime";
import type { ContextRepository } from "./context.js";

/**
 * The eight PSR-3 / RFC 5424 severity levels, most-severe first — the
 * same set Laravel's `Illuminate\Log\Logger` exposes one method per
 * (`emergency`…`debug`). `warning` (not `warn`) is the canonical name.
 */
export type LogLevel =
  "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";

export interface Logger {
  emergency(message: string, context?: Record<string, unknown>): void;
  alert(message: string, context?: Record<string, unknown>): void;
  critical(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  warning(message: string, context?: Record<string, unknown>): void;
  notice(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;

  /**
   * Log at an arbitrary runtime-chosen level. Laravel's/PSR-3's
   * `log($level, $message, $context)` — handy when the level itself is a
   * variable (e.g. mapping an HTTP status class to a severity).
   */
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
}

/**
 * Implements all eight PSR-3 level methods and the generic `log()` in
 * terms of a single `write(level, message, context)` primitive each
 * concrete logger supplies — so a new backend (console, file, daily,
 * array, …) only writes one method instead of nine. Mirrors Laravel's
 * `Illuminate\Log\Logger` funnelling every level method through one
 * `writeLog()`.
 */
export abstract class AbstractLogger implements Logger {
  protected abstract write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void;

  emergency(message: string, context?: Record<string, unknown>): void {
    this.write("emergency", message, context);
  }
  alert(message: string, context?: Record<string, unknown>): void {
    this.write("alert", message, context);
  }
  critical(message: string, context?: Record<string, unknown>): void {
    this.write("critical", message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }
  warning(message: string, context?: Record<string, unknown>): void {
    this.write("warning", message, context);
  }
  notice(message: string, context?: Record<string, unknown>): void {
    this.write("notice", message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }
  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.write(level, message, context);
  }
}

/**
 * What a logger needs from the outside world to render Laravel-style log
 * lines: the environment name (the `production` in `production.DEBUG`)
 * and the global context repository whose data is appended to every line.
 * `Application` structurally satisfies this (it has `environment()` and a
 * `context` field), so loggers are constructed with the `Application`
 * instance itself — explicit injection rather than a hidden global
 * `app()` call inside the formatter, per this framework's "explicit DI"
 * philosophy.
 */
export interface LogSource {
  environment(): string;
  readonly context: ContextRepository;
}

/**
 * Formats a single log line as
 * `"[timestamp] env.LEVEL: message {context} {globalContext}"` — shared
 * by every `Logger` implementation in this package (`ConsoleLogger`,
 * `FileLogger`, `DailyLogger`) so all channels produce visually
 * consistent output. Exported (not private to this module) specifically
 * so other loggers can reuse it rather than duplicating the formatting
 * logic.
 *
 * Mirrors Laravel's default Monolog `LineFormatter` output
 * (`[%datetime%] %channel%.%level_name%: %message% %context% %extra%`):
 *
 *   [2026-08-24 12:00:05] production.ERROR: Something broke {"per":"call"} {"global":"context"}
 *
 * - Timestamp is `yyyy-MM-dd HH:mm:ss` in UTC (Laravel's `Y-m-d H:i:s`).
 * - The `env.` prefix comes from `source.environment()` — Laravel's
 *   fallback Monolog channel name is the app environment, which is where
 *   `production.DEBUG` comes from. When no `source` is supplied (a
 *   standalone logger constructed outside any `Application`), the prefix
 *   is omitted and the line is just `LEVEL: ...`, as before.
 * - Per-call `context` renders first, then the global
 *   `source.context.all()` data (Laravel's Context lands in `%extra%`,
 *   after `%context%`). Either is omitted entirely when empty, matching
 *   `ignoreEmptyContextAndExtra`.
 */
export function formatLogLine(
  level: string,
  message: string,
  context?: Record<string, unknown>,
  source?: LogSource,
): string {
  const timestamp = DateTime.now("UTC").format("yyyy-MM-dd HH:mm:ss");
  const levelPart = source ? `${source.environment()}.${level.toUpperCase()}` : level.toUpperCase();

  let suffix = "";

  if (context && Object.keys(context).length > 0) {
    suffix += ` ${safeStringify(context)}`;
  }

  const globalContext = source?.context.all();

  if (globalContext && Object.keys(globalContext).length > 0) {
    suffix += ` ${safeStringify(globalContext)}`;
  }

  return `[${timestamp}] ${levelPart}: ${message}${suffix}`;
}

/** Maximum nesting depth `safeStringify` descends before emitting `"[Object]"`. */
const MAX_SERIALIZE_DEPTH = 8;

/**
 * `JSON.stringify` for log context that can never throw and never loses
 * the things structured logging exists to capture.
 *
 * Plain `JSON.stringify(context)` is unusable in a logger's hot path:
 *
 * - an `Error` serialises to `{}` (its `message`/`stack` are
 *   non-enumerable), silently discarding the one thing you were logging;
 * - a circular reference throws `Converting circular structure to JSON`
 *   — from inside the log call, masking the original exception being
 *   reported;
 * - a `BigInt` throws `Do not know how to serialize a BigInt`.
 *
 * This normaliser handles each before handing off to `JSON.stringify`:
 * `Error` → `{ name, message, stack, cause? }`, circular references →
 * `"[Circular]"` (tracked per-branch via a `WeakSet`), `BigInt` →
 * decimal string, `Date` → ISO 8601, functions/symbols → tagged
 * placeholders, and anything past {@link MAX_SERIALIZE_DEPTH} → `"[Object]"`.
 * A final `try/catch` guarantees a string comes back no matter what a
 * pathological getter does. Mirrors Monolog's `NormalizerFormatter`.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(normalize(value, new WeakSet(), 0)) ?? String(value);
  } catch {
    return "[Unserializable]";
  }
}

function normalize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;

  if (type === "string" || type === "boolean") {
    return value;
  }

  if (type === "number") {
    return Number.isFinite(value as number) ? value : String(value);
  }

  if (type === "bigint") {
    return (value as bigint).toString();
  }

  if (type === "function") {
    return `[Function${(value as { name?: string }).name ? `: ${(value as { name: string }).name}` : ""}]`;
  }

  if (type === "symbol") {
    return (value as symbol).toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    const normalizedError: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };

    if (value.cause !== undefined) {
      normalizedError["cause"] = normalize(value.cause, seen, depth + 1);
    }

    return normalizedError;
  }

  if (type !== "object") {
    return String(value);
  }

  const object = value as object;

  if (seen.has(object)) {
    return "[Circular]";
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return "[Object]";
  }

  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return object.map((item) => normalize(item, seen, depth + 1));
    }

    // Honour user-defined toJSON (Date already handled above) before
    // walking own enumerable keys — matches JSON.stringify semantics.
    const maybeToJSON = (object as { toJSON?: () => unknown }).toJSON;

    if (typeof maybeToJSON === "function") {
      return normalize(maybeToJSON.call(object), seen, depth + 1);
    }

    const result: Record<string, unknown> = {};

    for (const key of Object.keys(object)) {
      result[key] = normalize((object as Record<string, unknown>)[key], seen, depth + 1);
    }

    return result;
  } finally {
    seen.delete(object);
  }
}

/**
 * Routes each PSR-3 level to the closest `console` method so severity is
 * preserved in dev tooling: `error`/`critical`/`alert`/`emergency` →
 * `console.error`, `warning`/`notice` → `console.warn`, `info` →
 * `console.info`, `debug` → `console.debug`.
 */
function consoleMethodFor(level: LogLevel): (message: string) => void {
  switch (level) {
    case "emergency":
    case "alert":
    case "critical":
    case "error":
      return console.error;
    case "warning":
    case "notice":
      return console.warn;
    case "info":
      return console.info;
    case "debug":
      return console.debug;
  }
}

export class ConsoleLogger extends AbstractLogger {
  constructor(private source?: LogSource) {
    super();
  }

  protected write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    consoleMethodFor(level)(formatLogLine(level, message, context, this.source));
  }
}
