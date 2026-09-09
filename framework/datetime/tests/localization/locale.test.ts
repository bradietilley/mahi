/**
 * Plan §21.
 *
 * These tests check *wiring*, not CLDR's contents. Asserting that August is
 * "août" in French is fine — that will not change — but asserting exact
 * `dateStyle` layouts would turn a Node upgrade into a build failure for no
 * benefit, so those are checked structurally.
 */

import { describe, expect, it } from "vitest";

import { setDefaultLocale } from "../../src/config.js";
import { DateTime } from "../../src/date-time.js";
import { Locale } from "../../src/locale.js";

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("Locale", () => {
  it("resolves and validates tags", () => {
    expect(Locale.isSupported("en")).toBe(true);
    expect(Locale.isSupported("fr-CA")).toBe(true);
    expect(Locale.isSupported("not a locale")).toBe(false);
    expect(Locale.resolve("en-XX")).toBe("en");
  });

  it("reports the configured locale", () => {
    setDefaultLocale("fr");
    expect(Locale.current()).toBe("fr");
  });

  it("lists month names in the locale's own language", () => {
    expect(Locale.monthNames("long", "en")[7]).toBe("August");
    expect(Locale.monthNames("short", "en")[7]).toBe("Aug");
    expect(Locale.monthNames("long", "fr")[7]).toBe("août");
    expect(Locale.monthNames("long", "en")).toHaveLength(12);
  });

  it("indexes weekday names from Sunday, matching dayOfWeek", () => {
    const names = Locale.weekdayNames("long", "en");

    expect(names[0]).toBe("Sunday");
    expect(names[6]).toBe("Saturday");
    expect(Locale.weekdayNames("long", "fr")[0]).toBe("dimanche");
  });

  it("reports the locale's conventional week start without imposing it", () => {
    // The US starts its week on Sunday; the package still defaults to Monday
    // unless told otherwise, which is the point of keeping these separate.
    expect(Locale.firstDayOfWeek("en-US")).toBe(0);
    expect(Locale.firstDayOfWeek("en-GB")).toBe(1);
    expect(utc("2026-08-23T12:00:00Z").startOfWeek().toISODate()).toBe("2026-08-17");
    expect(
      utc("2026-08-23T12:00:00Z")
        .startOfWeek({ weekStartsOn: Locale.firstDayOfWeek("en-US") })
        .toISODate(),
    ).toBe("2026-08-23");
  });

  it("reports locale weekends", () => {
    expect(Locale.weekendDays("en-US")).toEqual([6, 0]);
  });
});

describe("ordinals", () => {
  it("applies English suffixes from CLDR plural categories", () => {
    expect(Locale.ordinal(1, "en")).toBe("1st");
    expect(Locale.ordinal(2, "en")).toBe("2nd");
    expect(Locale.ordinal(3, "en")).toBe("3rd");
    expect(Locale.ordinal(4, "en")).toBe("4th");
    expect(Locale.ordinal(11, "en")).toBe("11th");
    expect(Locale.ordinal(21, "en")).toBe("21st");
    expect(Locale.ordinal(112, "en")).toBe("112th");
  });

  it("falls back to the plain numeral for unregistered languages", () => {
    // Rather than inventing a suffix that would be grammatically wrong.
    expect(Locale.hasOrdinalRule("de")).toBe(false);
    expect(Locale.ordinal(3, "de")).toBe("3");
  });

  it("accepts a registered rule, keyed by primary language", () => {
    Locale.registerOrdinal("fr", (value) => (value === 1 ? "1er" : `${value}e`));

    expect(Locale.ordinal(1, "fr")).toBe("1er");
    expect(Locale.ordinal(4, "fr-CA")).toBe("4e");
  });
});

describe("localized formatting", () => {
  const date = utc("2026-08-20T14:30:00Z");

  it("formats through Intl in the instance's own zone", () => {
    const perth = date.inTimezone("Australia/Perth");

    // 14:30 UTC is 22:30 in Perth; the zone must come from the instance, not
    // from the host.
    expect(perth.toLocaleTimeString({ timeStyle: "short", hour12: false }, "en-GB")).toBe("22:30");
    expect(date.toLocaleTimeString({ timeStyle: "short", hour12: false }, "en-GB")).toBe("14:30");
  });

  it("renders the same instant differently per locale", () => {
    expect(date.toLocaleDateString({ dateStyle: "long" }, "en-GB")).toBe("20 August 2026");
    expect(date.toLocaleDateString({ dateStyle: "long" }, "fr")).toBe("20 août 2026");
  });

  it("uses the configured locale by default", () => {
    setDefaultLocale("fr");
    expect(date.toLocaleDateString({ dateStyle: "long" })).toBe("20 août 2026");
  });

  it("names months and weekdays", () => {
    expect(date.monthName("long", "en")).toBe("August");
    expect(date.monthName("short", "en")).toBe("Aug");
    expect(date.dayName("long", "en")).toBe("Thursday");
    expect(date.dayName("long", "fr")).toBe("jeudi");
  });

  it("renders the ordinal day", () => {
    expect(date.ordinalDay("en")).toBe("20th");
    expect(utc("2026-08-01T00:00:00Z").ordinalDay("en")).toBe("1st");
  });

  it("reads names in the instance's zone, not the host's", () => {
    // 2026-08-20T20:00Z is Friday the 21st in Perth.
    const perth = DateTime.parse("2026-08-20T20:00:00Z", "Australia/Perth");

    expect(perth.dayName("long", "en")).toBe("Friday");
    expect(perth.ordinalDay("en")).toBe("21st");
  });
});
