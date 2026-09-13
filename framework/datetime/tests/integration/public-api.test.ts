/**
 * Plan §29 and §34: the package's *shape* as a contract.
 *
 * These tests fail when the public surface changes, which is the point, an
 * export added by accident is as much of a problem as one removed by
 * accident, because everything listed here is something consumers may depend
 * on and semantic versioning must therefore protect.
 *
 * The generated `.d.ts` is also scanned for leaked implementation types. §24's
 * dependency boundary is only real if it is checked; a `date-fns` type
 * appearing in a public signature would make swapping the dependency a
 * breaking change, quietly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as api from "../../src/index.js";

const EXPECTED_VALUE_EXPORTS = [
  "AmbiguousTimeError",
  "DateTime",
  "DateTimeError",
  "Duration",
  "Interval",
  "InvalidDateTimeError",
  "InvalidDurationError",
  "InvalidFormatError",
  "InvalidIntervalError",
  "InvalidTimezoneError",
  "Locale",
  "Period",
  "Timezone",
  "getDefaultLocale",
  "getDefaultTimezone",
  "getDefaultWeekStartsOn",
  "resetDefaultLocale",
  "resetDefaultTimezone",
  "setDefaultLocale",
  "setDefaultTimezone",
  "setDefaultWeekStartsOn",
] as const;

describe("public API", () => {
  it("exports exactly the documented surface", () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  it("exposes no internals", () => {
    for (const name of Object.keys(api)) {
      expect(name.startsWith("_"), `${name} looks internal`).toBe(false);
    }
  });

  it("keeps every temporal value immutable", () => {
    const date = api.DateTime.parse("2026-08-20T12:00:00Z", "UTC");
    const duration = api.Duration.hours(3);
    const interval = api.Interval.between(date, date.addDays(1));
    const period = api.Period.days(date, date.addDays(3));

    for (const value of [date, duration, interval, period]) {
      expect(Object.isFrozen(value), `${value.constructor.name} is not frozen`).toBe(true);
    }
  });

  it("keeps every error catchable as one family", () => {
    const errors = [
      () => api.DateTime.parse("nonsense"),
      () => api.DateTime.now("Nowhere/Special"),
      () => api.DateTime.parse("2026-08-20T12:00:00Z").format("YYYY"),
      () => api.Duration.months(1).totalDays,
      () => api.Interval.between("2026-08-21T00:00:00Z", "2026-08-20T00:00:00Z"),
    ];

    for (const trigger of errors) {
      expect(trigger).toThrow(api.DateTimeError);
    }
  });

  it("refuses to construct an invalid DateTime, even from plain JavaScript", () => {
    // TypeScript's `private constructor` is erased at runtime, so a JS caller
    // can reach it. "A DateTime is always a valid instant" would be a hollow
    // guarantee if it only held for callers who compiled.
    const Constructible = api.DateTime as unknown as new (...args: unknown[]) => unknown;

    expect(() => new Constructible()).toThrow(api.InvalidDateTimeError);
    expect(() => new Constructible(Number.NaN, "UTC")).toThrow(api.InvalidDateTimeError);
    expect(() => new Constructible(Number.POSITIVE_INFINITY, "UTC")).toThrow(
      api.InvalidDateTimeError,
    );
  });
});

describe("dependency boundary", () => {
  const declarations = readFileSync(
    fileURLToPath(new URL("../../dist/index.d.ts", import.meta.url)),
    "utf8",
  );

  it("re-exports only from within the package", () => {
    // The barrel is the whole public surface, so anything it names is public.
    expect(declarations).not.toMatch(/from ["']date-fns/u);
    expect(declarations).not.toMatch(/from ["'][^"']*internal/u);
  });
});

describe("runtime expectations", () => {
  it("has the Intl data the package relies on", () => {
    // Localization and relative time are delegated to the host rather than
    // bundled (§21). A `small-icu` build would fail here rather than silently
    // rendering everything in English.
    expect(typeof Intl.RelativeTimeFormat).toBe("function");
    expect(typeof Intl.ListFormat).toBe("function");
    expect(typeof Intl.PluralRules).toBe("function");
    expect(Intl.DateTimeFormat.supportedLocalesOf(["fr"])).toEqual(["fr"]);
  });

  it("resolves IANA zones, including ones with unusual offsets", () => {
    // Chatham is UTC+12:45, a quarter-hour offset that a naive
    // minutes-only implementation would round away.
    expect(api.Timezone.offsetMinutesAt("Pacific/Chatham", Date.UTC(2026, 6, 1))).toBe(765);
    expect(api.Timezone.offsetMinutesAt("Asia/Kolkata", Date.UTC(2026, 6, 1))).toBe(330);
  });

  it("survives a JSON round trip through structured data", () => {
    const original = api.DateTime.parse("2026-08-20T14:30:00", "Australia/Perth");
    const revived = api.DateTime.parse(JSON.parse(JSON.stringify(original)) as string);

    expect(revived.isEqual(original)).toBe(true);
  });
});
