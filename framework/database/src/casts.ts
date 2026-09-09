import { DateTime } from "@mahi/datetime";

/**
 * A bidirectional attribute cast — the typed replacement for Laravel's
 * string-literal casts (`'boolean'`, `'datetime'`, `'decimal:2'`). Where
 * Eloquent keys a cast by an opaque string and resolves the behavior at
 * runtime, a `Cast` is a plain object carrying both directions of the
 * conversion AND (via its two type parameters) the model-facing and
 * database-facing TypeScript types, so a model's declared `casts` map
 * drives the instance's attribute types automatically — see `Casts<Row>`
 * and `ModelTypeOf`/`DbTypeOf` below, and `model.ts`'s `Attributes<>`
 * type that applies them.
 *
 * - `ModelType` is what interacting with the instance deals in:
 *   `post.published` reads as a `boolean`.
 * - `DbType` is what's stored/queried: the underlying column value
 *   (`0`/`1` for a boolean flag). `toDatabaseType` accepts `ModelType |
 *   DbType` on purpose, so lenient inbound assignment works —
 *   `post.view_count = "34534534"` (a string, the DB type) is as valid as
 *   `post.view_count = 34534534` (a number, the model type).
 *
 * `null` is always passed straight through in both directions (a nullable
 * column stays nullable regardless of cast) — every built-in below short-
 * circuits on it, and custom casts should too.
 */
export interface Cast<ModelType, DbType> {
  /** DB value → model value (`0` → `false`). Called on read/hydration. */
  toModelType(dbValue: DbType): ModelType;
  /** Model (or lenient DB) value → DB value (`false` → `0`). Called on write. */
  toDatabaseType(modelValue: ModelType | DbType): DbType;
}

/** Extracts a cast's model-facing type — used by `Attributes<>` to type instance attributes. */
export type ModelTypeOf<C> = C extends Cast<infer M, any> ? M : never;

/** Extracts a cast's database-facing type. */
export type DbTypeOf<C> = C extends Cast<any, infer D> ? D : never;

/**
 * A model's `casts` map: a subset of its `Row` columns, each mapped to a
 * `Cast`. Declared as `static casts = {...} satisfies Casts<Row>` so the
 * keys are checked against real columns while the concrete cast types are
 * preserved for `Attributes<>` inference.
 */
export type Casts<Row> = Partial<Record<keyof Row & string, Cast<any, any>>>;

/** `true` for `null`/`undefined` — the pass-through guard every cast shares. */
function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * `integer` — parses strings/numbers to an integer. Accepts a lenient
 * `number | string` DB type so `"34534534"` from a text column (or a
 * user assignment) round-trips.
 */
export const IntegerCast: Cast<number, number | string> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    return typeof dbValue === "number" ? Math.trunc(dbValue) : Math.trunc(Number(dbValue));
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    return typeof modelValue === "number" ? Math.trunc(modelValue) : Math.trunc(Number(modelValue));
  },
};

/** `float` — parses strings/numbers to a floating-point number (no truncation). */
export const FloatCast: Cast<number, number | string> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    return typeof dbValue === "number" ? dbValue : Number(dbValue);
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    return typeof modelValue === "number" ? modelValue : Number(modelValue);
  },
};

/** `string` — coerces to a string (a numeric column read as text on the model side). */
export const StringCast: Cast<string, string | number> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    return String(dbValue);
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    // A temporal value gets the framework's UTC spelling rather than
    // `String()`'s. `String(dateTime)` calls `toString()`, which renders
    // in the instance's *own* zone — so assigning a `DateTime` to a
    // text-typed timestamp column (an app that declares
    // `email_verified_at: string`, say) would store
    // `...T14:30:00.000+08:00` and disagree with every other datetime in
    // the database. The rule is the same one `DateTimeCast` and
    // `normalizeBinding()` apply: what goes into the database is UTC.
    // Widened first: the declared `ModelType` is `string`, but a cast
    // must tolerate being handed the other shape by contract, and this
    // is the case that matters.
    const value = modelValue as unknown;

    if (value instanceof DateTime) {
      return value.setTimezone("UTC").toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return String(modelValue);
  },
};

/**
 * `boolean` — DB `0`/`1` (or a real boolean) ↔ model `boolean`. Stores
 * as `0`/`1` (SQLite has no native boolean), reads any truthy DB value
 * as `true` with `0`/`"0"`/`false` as `false`.
 */
export const BooleanCast: Cast<boolean, number | boolean> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    if (typeof dbValue === "boolean") {
      return dbValue;
    }

    return dbValue !== 0;
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    return modelValue ? 1 : 0;
  },
};

/**
 * `decimal:precision` — kept as a fixed-precision **string** on the model
 * side (not a `number`) to avoid binary-float precision loss for money-
 * like values. `decimal(2)` formats to two places on both read and write.
 * Accepts a lenient `number | string` DB type.
 */
export function decimal(precision: number): Cast<string, number | string> {
  return {
    toModelType(dbValue) {
      if (isNullish(dbValue)) {
        return dbValue as never;
      }

      return Number(dbValue).toFixed(precision);
    },
    toDatabaseType(modelValue) {
      if (isNullish(modelValue)) {
        return modelValue as never;
      }

      return Number(modelValue).toFixed(precision);
    },
  };
}

/**
 * `array` — a JSON-encoded array column ↔ a real array on the model side.
 * `toModelType` parses; already-parsed arrays (e.g. set directly on the
 * instance before a save round-trip) pass straight through.
 */
// The DB type is `string | any[]`, not just `string`, because
// `toModelType` deliberately passes an already-parsed array straight
// through (see the note above) — a case the narrower `string` made
// impossible to express at a call site even though it always worked.
export const ArrayCast: Cast<any[], string | any[]> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    if (Array.isArray(dbValue)) {
      return dbValue;
    }

    return JSON.parse(dbValue as string);
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    return typeof modelValue === "string" ? modelValue : JSON.stringify(modelValue);
  },
};

/**
 * `json` — a JSON-encoded column ↔ its parsed value (object, array,
 * primitive) on the model side. Like `ArrayCast` but not array-specific.
 *
 * Its model type is `unknown`, which is the honest type for "whatever was
 * in that column": nothing validates the shape on read. Since casts now
 * *replace* the row's declared type on finder results rather than
 * intersecting with it, a column declared `Record<string, unknown> | null`
 * and cast with this will type as `unknown` — the cast is the narrower
 * claim, and it wins.
 *
 * When the column's shape IS known, use {@link json} instead, which keeps
 * the declared type. This constant remains for the genuinely-unknown case
 * and for backward compatibility.
 */
export const JsonCast: Cast<unknown, string> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    if (typeof dbValue !== "string") {
      return dbValue;
    }

    return JSON.parse(dbValue);
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    if (typeof modelValue === "string") {
      return modelValue;
    }

    return JSON.stringify(modelValue);
  },
};

/**
 * `json<T>()` — the same encoding as {@link JsonCast}, with the model-side
 * type the caller declares.
 *
 * A factory rather than a generic constant because a `const` cannot carry
 * an un-applied type parameter: `JsonCast` has to resolve its `ModelType`
 * at declaration, and the only sound choice there is `unknown`. Calling
 * `json<Meta>()` applies it at the use site, where the shape is actually
 * known:
 *
 * ```ts
 * static override casts = {
 *   meta: json<Record<string, unknown>>(),
 * } satisfies Casts<PostTable>;
 * ```
 *
 * **This is a claim, not a validation.** Nothing checks the parsed value
 * against `T` — the same position `JSON.parse` puts every caller in. It is
 * the right trade for a column the application itself writes, and the wrong
 * one for untrusted input, which wants a schema rather than a cast.
 *
 * Null passes through, so a nullable column keeps its `| null` on the Row
 * and does not need it repeated in `T`.
 */
export function json<T>(): Cast<T, string> {
  return JsonCast as Cast<T, string>;
}

/**
 * `datetime` — a timestamp column ↔ a `DateTime` (`@mahi/datetime`) on
 * the model side, mirroring Laravel's Carbon casting.
 *
 * The DB type is `string | Date` rather than just `string` because what
 * comes off the wire depends on the engine and its driver
 * configuration. This framework's own MySQL/Postgres drivers are
 * configured to return timestamp text (see their "Value handling"
 * docstrings), but a `Date` still reaches here from a caller-supplied
 * pool `options`, a `DATE`-typed column, or an application assigning
 * `new Date()` to the attribute directly — and `DateTime.fromISO()`
 * takes only a string, so an unconverted `Date` failed with
 * `input.trim is not a function`.
 *
 * Both engines' text spellings are accepted on read: ISO-8601
 * (`2026-09-02T07:31:37.499Z`, SQLite/Postgres) and MySQL's
 * space-separated `2026-09-02 07:31:37.499`, which has no zone marker
 * and is read as UTC — the framework only ever writes UTC into
 * timestamp columns (see `formatTimestamp()`).
 *
 * Writes always produce ISO-8601. The MySQL-specific spelling is
 * applied at the timestamp-stamping chokepoint rather than here,
 * because a cast has no access to the connection.
 */
export const DateTimeCast: Cast<DateTime, string | Date> = {
  toModelType(dbValue) {
    if (isNullish(dbValue)) {
      return dbValue as never;
    }

    if (dbValue instanceof Date) {
      return DateTime.fromISO(dbValue.toISOString(), "UTC");
    }

    const text = String(dbValue).trim();
    // "2026-09-02 07:31:37" (MySQL) → "2026-09-02T07:31:37Z". A value
    // that already carries a zone, or is already ISO, is left alone.
    const spaceSeparated = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text);

    return DateTime.fromISO(
      spaceSeparated ? `${spaceSeparated[1]}T${spaceSeparated[2]}Z` : text,
      "UTC",
    );
  },
  toDatabaseType(modelValue) {
    if (isNullish(modelValue)) {
      return modelValue as never;
    }

    // `.setTimezone("UTC")` first, always. `DateTime.toISOString()`
    // renders in the instance's *own* zone, so a `DateTime.now()` built
    // on a machine in Perth would otherwise serialise as
    // `2026-09-02T14:30:00.000+08:00`. Postgres `timestamptz` reads the
    // offset correctly, but `timestamp`, MySQL and SQLite all ignore it
    // and store the local wall clock as though it were UTC — shifting
    // the value by the offset on write, silently, on two engines out of
    // three. This cast documents that the framework only ever writes
    // UTC; converting here is what makes that true for a caller who
    // passed a zoned value.
    if (modelValue instanceof DateTime) {
      return modelValue.setTimezone("UTC").toISOString();
    }

    if (modelValue instanceof Date) {
      // A JS `Date` has no zone of its own — `toISOString()` is always
      // UTC — so this needs no conversion, only the shared spelling.
      return modelValue.toISOString();
    }

    return String(modelValue);
  },
};

/**
 * `enum` — narrows a text/number column to a fixed set of member values
 * on the model side. Purely a *type* narrowing plus a runtime membership
 * guard: the DB value is passed through unchanged when it is one of
 * `members`, and rejected (throws) otherwise, so an unexpected value
 * surfaces at read time rather than silently flowing through as the wrong
 * type. Use it for a `status: "draft" | "published"` column.
 */
export function enumCast<const T extends string | number>(members: readonly T[]): Cast<T, T> {
  const allowed = new Set<string | number>(members);

  return {
    toModelType(dbValue) {
      if (isNullish(dbValue)) {
        return dbValue as never;
      }

      if (!allowed.has(dbValue)) {
        throw new Error(
          `enum cast: value ${JSON.stringify(dbValue)} is not one of ${JSON.stringify(members)}.`,
        );
      }

      return dbValue;
    },
    toDatabaseType(modelValue) {
      if (isNullish(modelValue)) {
        return modelValue as never;
      }

      return modelValue;
    },
  };
}

/**
 * The namespaced cast factory — the recommended surface for a model's
 * `casts` map (`casts: { published: Cast.boolean(), meta: Cast.json<Meta>() }`).
 *
 * Coexists with the `Cast<M, D>` interface (type space) under the same
 * name — a value and a type may share an identifier — so `import { Cast }`
 * gives you both `Cast.boolean()` (this object) and `Cast<M, D>` (the
 * type). The individual `IntegerCast`/`BooleanCast`/… constants remain
 * exported as lower-level aliases; each factory returns the shared
 * singleton where there is nothing to parameterise, so `Cast.boolean()`
 * and `BooleanCast` are the same object.
 */
export const Cast = {
  integer(): Cast<number, number | string> {
    return IntegerCast;
  },
  float(): Cast<number, number | string> {
    return FloatCast;
  },
  string(): Cast<string, string | number> {
    return StringCast;
  },
  boolean(): Cast<boolean, number | boolean> {
    return BooleanCast;
  },
  decimal(precision: number): Cast<string, number | string> {
    return decimal(precision);
  },
  array<T = any>(): Cast<T[], string> {
    return ArrayCast as Cast<T[], string>;
  },
  json<T = unknown>(): Cast<T, string> {
    return json<T>();
  },
  datetime(): Cast<DateTime, string | Date> {
    return DateTimeCast;
  },
  enum<const T extends string | number>(members: readonly T[]): Cast<T, T> {
    return enumCast(members);
  },
} as const;
