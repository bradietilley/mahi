import { describe, expect, it } from "vitest";
import { DateTime } from "@mahi/datetime";
import {
  ArrayCast,
  BooleanCast,
  DateTimeCast,
  FloatCast,
  IntegerCast,
  JsonCast,
  StringCast,
  decimal,
  json,
} from "../src/casts.js";

describe("IntegerCast", () => {
  it("parses strings and truncates to an integer", () => {
    expect(IntegerCast.toModelType("34534534")).toBe(34534534);
    expect(IntegerCast.toModelType(3.9)).toBe(3);
    expect(IntegerCast.toDatabaseType("42")).toBe(42);
    expect(IntegerCast.toDatabaseType(42)).toBe(42);
  });

  it("passes null/undefined through", () => {
    expect(IntegerCast.toModelType(null as never)).toBeNull();
    expect(IntegerCast.toDatabaseType(undefined as never)).toBeUndefined();
  });
});

describe("FloatCast", () => {
  it("parses without truncating", () => {
    expect(FloatCast.toModelType("3.5")).toBe(3.5);
    expect(FloatCast.toDatabaseType(3.5)).toBe(3.5);
  });
});

describe("StringCast", () => {
  it("coerces to string both directions", () => {
    expect(StringCast.toModelType(42)).toBe("42");
    expect(StringCast.toDatabaseType(42)).toBe("42");
  });

  it("writes a DateTime as UTC rather than String()'s zone-local form", () => {
    // A text-typed timestamp column (`email_verified_at: string`) still
    // receives a `DateTime` from callers. `String(dt)` calls `toString()`,
    // which renders in the instance's own zone — storing
    // "...T07:29:12.868+08:00" alongside UTC values written everywhere
    // else, so the same column would hold two incompatible spellings.
    const perth = DateTime.fromISO("2026-08-23T14:30:00.000Z", "UTC").setTimezone(
      "Australia/Perth",
    );
    expect(String(perth)).toBe("2026-08-23T22:30:00.000+08:00");
    expect(StringCast.toDatabaseType(perth as never)).toBe("2026-08-23T14:30:00.000Z");
  });

  it("writes a Date as ISO", () => {
    expect(StringCast.toDatabaseType(new Date("2026-08-23T14:30:00.000Z") as never)).toBe(
      "2026-08-23T14:30:00.000Z",
    );
  });
});

describe("BooleanCast", () => {
  it("maps DB int to model boolean and back", () => {
    expect(BooleanCast.toModelType(1)).toBe(true);
    expect(BooleanCast.toModelType(0)).toBe(false);
    expect(BooleanCast.toModelType(true)).toBe(true);
    expect(BooleanCast.toDatabaseType(true)).toBe(1);
    expect(BooleanCast.toDatabaseType(false)).toBe(0);
  });

  it("round-trips DB -> model -> DB", () => {
    expect(BooleanCast.toDatabaseType(BooleanCast.toModelType(1))).toBe(1);
    expect(BooleanCast.toDatabaseType(BooleanCast.toModelType(0))).toBe(0);
  });
});

describe("decimal(n)", () => {
  it("formats to fixed precision as a string", () => {
    const price = decimal(2);
    expect(price.toModelType(3)).toBe("3.00");
    expect(price.toModelType("3.1")).toBe("3.10");
    expect(price.toDatabaseType("3.156")).toBe("3.16");
    expect(price.toDatabaseType(3)).toBe("3.00");
  });
});

describe("ArrayCast", () => {
  it("parses JSON and stringifies", () => {
    expect(ArrayCast.toModelType("[1,2,3]")).toEqual([1, 2, 3]);
    expect(ArrayCast.toModelType([1, 2])).toEqual([1, 2]);
    expect(ArrayCast.toDatabaseType([1, 2])).toBe("[1,2]");
    expect(ArrayCast.toDatabaseType("[1,2]")).toBe("[1,2]");
  });
});

describe("JsonCast", () => {
  it("parses JSON objects and stringifies", () => {
    expect(JsonCast.toModelType('{"a":1}')).toEqual({ a: 1 });
    expect(JsonCast.toDatabaseType({ a: 1 })).toBe('{"a":1}');
    expect(JsonCast.toModelType(null as never)).toBeNull();
  });

  /**
   * `json<T>()` exists so a column whose shape IS known keeps that shape on
   * finder results — casts now replace the row's declared type rather than
   * intersecting with it, so `JsonCast`'s honest `unknown` would erase it.
   *
   * The behaviour is deliberately identical; only the type differs, which
   * is what these assert alongside the type-level tests.
   */
  it("is the same cast as json<T>(), which only narrows the type", () => {
    const typed = json<{ a: number }>();

    expect(typed.toModelType('{"a":1}')).toEqual({ a: 1 });
    expect(typed.toDatabaseType({ a: 1 })).toBe('{"a":1}');
  });

  /**
   * Null passes through both directions, which is what lets a nullable
   * column keep its `| null` on the Row without repeating it in `T`.
   */
  it("passes null through, so a nullable column needs no null in T", () => {
    const typed = json<{ a: number }>();

    expect(typed.toModelType(null as never)).toBeNull();
    expect(typed.toDatabaseType(null as never)).toBeNull();
  });

  /**
   * An already-parsed value survives a write without being double-encoded —
   * the case that happens when an instance is saved twice without a read in
   * between.
   */
  it("does not double-encode a value that is already a string", () => {
    expect(json<unknown>().toDatabaseType('{"a":1}')).toBe('{"a":1}');
  });
});

describe("DateTimeCast", () => {
  it("maps ISO string to DateTime and back", () => {
    const iso = "2026-08-23T00:00:00.000Z";
    const dt = DateTimeCast.toModelType(iso);
    expect(dt).toBeInstanceOf(DateTime);
    expect(DateTimeCast.toDatabaseType(dt)).toBe(iso);
  });

  it("passes a raw string through on write", () => {
    const iso = "2026-08-23T00:00:00.000Z";
    expect(DateTimeCast.toDatabaseType(iso as never)).toBe(iso);
  });

  it("passes null through", () => {
    expect(DateTimeCast.toModelType(null as never)).toBeNull();
  });

  it("reads MySQL's space-separated form as UTC", () => {
    // MySQL returns "YYYY-MM-DD HH:MM:SS.mmm" with no zone marker; the
    // framework only ever writes UTC into timestamp columns.
    const dt = DateTimeCast.toModelType("2026-08-23 14:30:00.250");
    expect(dt).toBeInstanceOf(DateTime);
    expect(dt.toISOString()).toBe("2026-08-23T14:30:00.250Z");
  });

  it("reads a space-separated value without milliseconds", () => {
    expect(DateTimeCast.toModelType("2026-08-23 14:30:00").toISOString()).toBe(
      "2026-08-23T14:30:00.000Z",
    );
  });

  it("accepts a Date, which a driver may still hand back", () => {
    // node-postgres/mysql2 return `Date` by default, and an application
    // can assign one directly, so the cast cannot assume a string.
    const dt = DateTimeCast.toModelType(new Date("2026-08-23T14:30:00.000Z"));
    expect(dt).toBeInstanceOf(DateTime);
    expect(dt.toISOString()).toBe("2026-08-23T14:30:00.000Z");
  });

  it("serialises a Date to ISO on write", () => {
    expect(DateTimeCast.toDatabaseType(new Date("2026-08-23T14:30:00.000Z"))).toBe(
      "2026-08-23T14:30:00.000Z",
    );
  });

  it("converts a ZONED DateTime to UTC on write", () => {
    // `DateTime.toISOString()` renders in the instance's own zone, so
    // without an explicit conversion this wrote
    // "2026-08-23T22:30:00.000+08:00" — which `timestamp`, MySQL and
    // SQLite all store as 22:30 UTC, silently shifting the instant by
    // the offset. The cast documents that only UTC is ever written.
    const perth = DateTime.fromISO("2026-08-23T14:30:00.000Z", "UTC").setTimezone(
      "Australia/Perth",
    );
    expect(perth.toISOString()).toBe("2026-08-23T22:30:00.000+08:00");
    expect(DateTimeCast.toDatabaseType(perth)).toBe("2026-08-23T14:30:00.000Z");
  });
});
