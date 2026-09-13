import type { Dialect } from "./schema/dialect.js";

/**
 * Standardised database exceptions, mirroring the ones Laravel raises from
 * `Illuminate\Database`. The whole point is that application code catches a
 * *portable* error (`UniqueConstraintViolationException`) rather than
 * sniffing driver-specific error codes/messages (SQLite's
 * `SQLITE_CONSTRAINT_UNIQUE`, MySQL's `1062`, Postgres' `23505`) that
 * change per engine.
 *
 * `translateDatabaseError()` inspects the raw driver error and, when it
 * recognises a known class of failure, wraps it in the matching exception
 * (preserving the original as `.previous`). Unrecognised errors are wrapped
 * in a generic `QueryException` so callers always get a consistent shape
 * with `sql`/`bindings`/`connection` context attached.
 */

export interface QueryContext {
  connection?: string;
  sql?: string;
  bindings?: readonly unknown[];
}

/** Base for every database error this framework raises. */
export class QueryException extends Error {
  readonly connection?: string;
  readonly sql?: string;
  readonly bindings?: readonly unknown[];
  readonly previous?: unknown;
  /** Driver-specific SQLSTATE / error code, when available. */
  readonly code?: string;

  constructor(message: string, context: QueryContext = {}, previous?: unknown) {
    super(message);
    this.name = new.target.name;
    this.connection = context.connection;
    this.sql = context.sql;
    this.bindings = context.bindings;
    this.previous = previous;
    this.code = extractCode(previous);

    // Preserve the original stack/cause for debugging.
    if (previous instanceof Error) {
      (this as { cause?: unknown }).cause = previous;
    }
  }
}

/**
 * A row violated a UNIQUE / PRIMARY KEY constraint. Laravel's
 * `UniqueConstraintViolationException`.
 */
export class UniqueConstraintViolationException extends QueryException {}

/**
 * A row violated a FOREIGN KEY constraint (missing parent, or a referenced
 * row still has children). Not a distinct Laravel class, but a common and
 * useful one to catch portably.
 */
export class ForeignKeyConstraintViolationException extends QueryException {}

/**
 * A NOT NULL column received a null value.
 */
export class NotNullConstraintViolationException extends QueryException {}

/** The connection to the database was lost. Laravel's `LostConnectionException`. */
export class LostConnectionException extends QueryException {}

function extractCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const e = error as { code?: unknown; errno?: unknown };

  if (typeof e.code === "string") {
    return e.code;
  }

  if (typeof e.code === "number") {
    return String(e.code);
  }

  if (typeof e.errno === "number") {
    return String(e.errno);
  }

  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isUniqueViolation(dialect: Dialect, error: unknown): boolean {
  const message = messageOf(error);
  const code = extractCode(error);
  switch (dialect) {
    case "sqlite":
      return /UNIQUE constraint failed|is not unique/i.test(message);
    case "mysql":
      // 1062 = ER_DUP_ENTRY.
      return code === "1062" || /Duplicate entry|ER_DUP_ENTRY/i.test(message);
    case "postgres":
      // 23505 = unique_violation.
      return code === "23505" || /duplicate key value violates unique constraint/i.test(message);
  }
}

function isForeignKeyViolation(dialect: Dialect, error: unknown): boolean {
  const message = messageOf(error);
  const code = extractCode(error);
  switch (dialect) {
    case "sqlite":
      return /FOREIGN KEY constraint failed/i.test(message);
    case "mysql":
      // 1451/1452 = cannot delete/add, FK constraint fails.
      return (
        code === "1451" ||
        code === "1452" ||
        /foreign key constraint fails|ER_(ROW_IS_REFERENCED|NO_REFERENCED_ROW)/i.test(message)
      );
    case "postgres":
      // 23503 = foreign_key_violation.
      return code === "23503" || /violates foreign key constraint/i.test(message);
  }
}

function isNotNullViolation(dialect: Dialect, error: unknown): boolean {
  const message = messageOf(error);
  const code = extractCode(error);
  switch (dialect) {
    case "sqlite":
      return /NOT NULL constraint failed/i.test(message);
    case "mysql":
      // 1048 = ER_BAD_NULL_ERROR.
      return code === "1048" || /cannot be null|ER_BAD_NULL_ERROR/i.test(message);
    case "postgres":
      // 23502 = not_null_violation.
      return code === "23502" || /violates not-null constraint/i.test(message);
  }
}

function isLostConnection(dialect: Dialect, error: unknown): boolean {
  const message = messageOf(error);
  const code = extractCode(error);
  const common =
    /server has gone away|Lost connection|Connection terminated|Connection lost|ECONNRESET|EPIPE|read ECONNRESET/i;

  if (common.test(message)) {
    return true;
  }

  switch (dialect) {
    case "mysql":
      return code === "2006" || code === "2013";
    case "postgres":
      // 08006/08003/57P01 = connection failures / admin shutdown.
      return code === "08006" || code === "08003" || code === "57P01";
    case "sqlite":
      return false;
  }
}

/**
 * Translate a raw driver error into a standardised `QueryException`
 * subclass. Already-translated errors pass through unchanged so wrapping is
 * idempotent (a rethrow through two layers won't double-wrap).
 */
export function translateDatabaseError(
  dialect: Dialect,
  error: unknown,
  context: QueryContext = {},
): QueryException {
  if (error instanceof QueryException) {
    return error;
  }

  const message = messageOf(error);

  if (isUniqueViolation(dialect, error)) {
    return new UniqueConstraintViolationException(message, context, error);
  }

  if (isForeignKeyViolation(dialect, error)) {
    return new ForeignKeyConstraintViolationException(message, context, error);
  }

  if (isNotNullViolation(dialect, error)) {
    return new NotNullConstraintViolationException(message, context, error);
  }

  if (isLostConnection(dialect, error)) {
    return new LostConnectionException(message, context, error);
  }

  return new QueryException(message, context, error);
}
