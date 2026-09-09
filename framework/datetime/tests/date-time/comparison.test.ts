import { afterEach, describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";

afterEach(() => DateTime.setTestNow(null));

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("DateTime comparison", () => {
  const earlier = utc("2026-08-20T10:00:00Z");
  const later = utc("2026-08-20T12:00:00Z");

  it("orders by instant", () => {
    expect(earlier.isBefore(later)).toBe(true);
    expect(later.isAfter(earlier)).toBe(true);
    expect(earlier.isAfter(later)).toBe(false);
    expect(earlier.compareTo(later)).toBe(-1);
    expect(later.compareTo(earlier)).toBe(1);
    expect(earlier.compareTo(earlier)).toBe(0);
  });

  it("supports the inclusive orderings", () => {
    expect(earlier.isBeforeOrEqual(earlier)).toBe(true);
    expect(earlier.isAfterOrEqual(earlier)).toBe(true);
    expect(earlier.isAfterOrEqual(later)).toBe(false);
  });

  it("compares instants regardless of display zone", () => {
    // Same moment, two clocks. Equality is about the instant, not the label.
    const perth = DateTime.parse("2026-08-20T14:00:00+08:00", "Australia/Perth");
    const london = perth.inTimezone("Europe/London");

    expect(perth.isEqual(london)).toBe(true);
    expect(perth.hour).not.toBe(london.hour);
    expect(perth.isIdentical(london)).toBe(false);
    expect(perth.isIdentical(perth.inTimezone("Australia/Perth"))).toBe(true);
  });

  it("coerces strings, numbers, and Dates in comparisons", () => {
    expect(earlier.isBefore("2026-08-20T12:00:00Z")).toBe(true);
    expect(earlier.isBefore(later.epochMilliseconds)).toBe(true);
    expect(earlier.isBefore(new Date("2026-08-20T12:00:00Z"))).toBe(true);
  });

  describe("calendar equality", () => {
    it("compares by calendar unit", () => {
      const a = utc("2026-08-20T01:00:00Z");
      const b = utc("2026-08-20T23:00:00Z");

      expect(a.isSameDay(b)).toBe(true);
      expect(a.isSameWeek(b)).toBe(true);
      expect(a.isSameMonth(b)).toBe(true);
      expect(a.isSameQuarter(b)).toBe(true);
      expect(a.isSameYear(b)).toBe(true);
      expect(a.isEqual(b)).toBe(false);
    });

    it("distinguishes adjacent units", () => {
      expect(utc("2026-08-31T23:00:00Z").isSameMonth(utc("2026-09-01T01:00:00Z"))).toBe(false);
      expect(utc("2026-09-30T12:00:00Z").isSameQuarter(utc("2026-10-01T12:00:00Z"))).toBe(false);
      expect(utc("2026-12-31T12:00:00Z").isSameYear(utc("2027-01-01T12:00:00Z"))).toBe(false);
    });

    it("answers calendar questions in the receiver's zone", () => {
      // 2026-08-20T20:00Z is the 20th in London and the 21st in Perth, so
      // "same day" depends on whose calendar is asked — which is why the
      // receiver's zone wins.
      const instant = "2026-08-20T20:00:00Z";
      const londonView = DateTime.parse(instant, "Europe/London");
      const perthView = DateTime.parse(instant, "Australia/Perth");

      expect(londonView.isSameDay(DateTime.parse("2026-08-20T10:00:00Z", "UTC"))).toBe(true);
      expect(perthView.isSameDay(DateTime.parse("2026-08-20T10:00:00Z", "UTC"))).toBe(false);
    });

    it("respects weekStartsOn for same-week checks", () => {
      const sunday = utc("2026-08-23T12:00:00Z");
      const monday = utc("2026-08-24T12:00:00Z");

      expect(sunday.isSameWeek(monday, { weekStartsOn: 1 })).toBe(false);
      expect(sunday.isSameWeek(monday, { weekStartsOn: 0 })).toBe(true);
    });
  });

  describe("isBetween", () => {
    const value = utc("2026-08-20T12:00:00Z");

    it("is inclusive by default", () => {
      expect(value.isBetween("2026-08-20T12:00:00Z", "2026-08-21T00:00:00Z")).toBe(true);
      expect(
        value.isBetween("2026-08-20T12:00:00Z", "2026-08-21T00:00:00Z", { inclusive: false }),
      ).toBe(false);
    });

    it("accepts bounds in either order", () => {
      expect(value.isBetween("2026-08-21T00:00:00Z", "2026-08-20T00:00:00Z")).toBe(true);
    });

    it("excludes values outside the range", () => {
      expect(value.isBetween("2026-08-21T00:00:00Z", "2026-08-22T00:00:00Z")).toBe(false);
    });
  });

  describe("relative to now", () => {
    it("reads isPast/isFuture from the frozen clock", () => {
      DateTime.setTestNow("2026-08-20T12:00:00Z");

      expect(utc("2026-08-20T11:59:59Z").isPast()).toBe(true);
      expect(utc("2026-08-20T12:00:01Z").isFuture()).toBe(true);
      expect(utc("2026-08-20T12:00:00Z").isPast()).toBe(false);
      expect(utc("2026-08-20T12:00:00Z").isFuture()).toBe(false);
    });

    it("reads isToday/isTomorrow/isYesterday in the instance's own zone", () => {
      DateTime.setTestNow("2026-08-20T12:00:00Z");

      expect(utc("2026-08-20T23:00:00Z").isToday()).toBe(true);
      expect(utc("2026-08-21T05:00:00Z").isTomorrow()).toBe(true);
      expect(utc("2026-08-19T05:00:00Z").isYesterday()).toBe(true);
      expect(utc("2026-08-22T05:00:00Z").isToday()).toBe(false);
    });
  });

  describe("selection", () => {
    it("finds the earliest and latest of several values", () => {
      const values = ["2026-08-20T12:00:00Z", "2026-08-19T12:00:00Z", "2026-08-21T12:00:00Z"];

      expect(DateTime.min(...values).toISODate()).toBe("2026-08-19");
      expect(DateTime.max(...values).toISODate()).toBe("2026-08-21");
    });

    it("requires at least one value", () => {
      expect(() => DateTime.min()).toThrow();
      expect(() => DateTime.max()).toThrow();
    });

    it("finds the nearest and furthest candidate in either direction", () => {
      const anchor = utc("2026-08-20T12:00:00Z");

      expect(anchor.closest("2026-08-20T11:00:00Z", "2026-08-20T14:00:00Z").toISOString()).toBe(
        "2026-08-20T11:00:00.000Z",
      );
      expect(anchor.farthest("2026-08-20T11:00:00Z", "2026-08-20T14:00:00Z").toISOString()).toBe(
        "2026-08-20T14:00:00.000Z",
      );
    });
  });

  it("supports native relational operators via valueOf", () => {
    expect(earlier < later).toBe(true);
    expect(later > earlier).toBe(true);
    expect(+earlier).toBe(earlier.epochMilliseconds);
  });
});
