import type { Kysely } from "kysely";
import { DateTime } from "@mahiframework/datetime";
import { dialectOf } from "./drivers/dialect-registry.js";
import type { Dialect } from "./schema/dialect.js";

/**
 * The string written into a timestamp column for `now`, spelled the way
 * `dialect` will accept.
 *
 * There is one engine-specific rule here:
 * **MySQL rejects the ISO-8601 `Z` suffix.** In the strict SQL mode that
 * has been the default since 5.7, `'2026-09-02T07:31:37.499Z'` is not a
 * valid `DATETIME`/`TIMESTAMP` literal and the write fails outright:
 *
 *     Incorrect datetime value: '2026-09-02T07:31:37.499Z' for column 'created_at'
 *
 * Since the migrations table stamps `migrated_at` the same way every
 * model stamps `created_at`, that made `migrate` unable to record a
 * single migration on MySQL — the framework could not bootstrap a
 * schema there at all.
 *
 * So MySQL gets the space-separated form it does accept
 * (`2026-09-02 07:31:37.499`), always in UTC. SQLite and Postgres keep
 * the ISO spelling: SQLite is typeless and stores whatever it is
 * given (and existing rows are already ISO), and Postgres parses the
 * `Z` correctly into both `timestamp` and `timestamptz`.
 *
 * Both forms are read back the same way — the Postgres driver
 * normalises its date/time text to ISO, MySQL's returns the
 * space-separated form, and `DateTime.fromISO()` accepts either — so
 * the difference does not leak past the driver boundary.
 *
 * Sub-second precision is included because a `timestamp(3)`/
 * `timestamp(6)` column stores it, and dropping it here would silently
 * coarsen every model's `created_at` to whole seconds. A column
 * declared without precision (this framework's `timestamp()` default)
 * truncates it server-side, which is the engine's decision to make, not
 * this function's.
 */
export function formatTimestamp(dialect: Dialect, now: DateTime = DateTime.now("UTC")): string {
  const utc = now.setTimezone("UTC");

  return dialect === "mysql" ? utc.format("yyyy-MM-dd HH:mm:ss.SSS") : utc.toISOString();
}

/**
 * `formatTimestamp()` for the engine behind `db` — the form every
 * timestamp-stamping call site uses, since they hold a connection
 * rather than a dialect.
 */
export function currentTimestampFor(db: Kysely<any>, now?: DateTime): string {
  return formatTimestamp(dialectOf(db), now);
}

/**
 * A full ISO-8601 datetime carrying a zone — `2026-09-02T07:31:37.499Z`
 * or `...+08:00`. Deliberately strict: a bare date, a time, or anything
 * with trailing text does not match, so only values that are
 * unambiguously an instant are rewritten.
 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * One value on its way into a datetime column, spelled for `dialect`.
 *
 * The problem this solves is the same one `formatTimestamp()` handles
 * for auto-stamped columns, one layer out: `DateTimeCast` serialises to
 * ISO-8601 with a `Z`, and **MySQL rejects that spelling** for any
 * `DATETIME`/`TIMESTAMP` column, not just `created_at`. So a model
 * declaring `casts = { published_at: DateTimeCast }` could not write
 * `published_at` at all on MySQL.
 *
 * Applied only to columns a model **declares** as `DateTimeCast` (see
 * `prepareTemporalWrites()`), never to arbitrary values: rewriting
 * every ISO-looking string would corrupt a `varchar` column that
 * legitimately stores one.
 *
 * Non-MySQL dialects, and values that aren't a recognisable instant,
 * pass through untouched.
 */
export function toDriverTimestamp(dialect: Dialect, value: unknown): unknown {
  if (dialect !== "mysql") {
    return value;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof DateTime) {
    return formatTimestamp(dialect, value);
  }

  if (value instanceof Date) {
    return formatTimestamp(dialect, DateTime.fromISO(value.toISOString(), "UTC"));
  }

  if (typeof value === "string" && ISO_WITH_ZONE.test(value)) {
    return formatTimestamp(dialect, DateTime.fromISO(value, "UTC"));
  }

  return value;
}

/**
 * `values` with every column `modelClass` casts as a datetime rewritten
 * into `dialect`'s accepted spelling — see `toDriverTimestamp()`.
 *
 * Returns the original object when nothing needs changing (every
 * dialect but MySQL, or a model with no datetime casts), so the common
 * path allocates nothing.
 */
export function prepareTemporalWrites<T extends Record<string, any>>(
  dialect: Dialect,
  temporalColumns: readonly string[],
  values: T,
): T {
  if (dialect !== "mysql" || temporalColumns.length === 0) {
    return values;
  }

  let copy: Record<string, any> | undefined;

  for (const column of temporalColumns) {
    if (!(column in values)) {
      continue;
    }

    const prepared = toDriverTimestamp(dialect, values[column]);

    if (prepared === values[column]) {
      continue;
    }

    copy ??= { ...values };
    copy[column] = prepared;
  }

  return (copy as T) ?? values;
}
