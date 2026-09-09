import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("DateTime differences", () => {
  it("is positive when the argument is later", () => {
    const a = utc("2026-08-20T00:00:00Z");
    const b = utc("2026-08-25T00:00:00Z");

    expect(a.diffInDays(b)).toBe(5);
    expect(b.diffInDays(a)).toBe(-5);
    expect(b.diffInDays(a, { absolute: true })).toBe(5);
  });

  it("measures exact units", () => {
    const a = utc("2026-08-20T00:00:00Z");
    const b = utc("2026-08-20T03:45:30.500Z");

    expect(a.diffInMilliseconds(b)).toBe(13_530_500);
    expect(a.diffInSeconds(b)).toBe(13_530);
    expect(a.diffInMinutes(b)).toBe(225);
    expect(a.diffInHours(b)).toBe(3);
  });

  it("truncates toward zero by default and can return a fraction", () => {
    const a = utc("2026-08-20T00:00:00Z");
    const b = utc("2026-08-20T12:00:00Z");

    expect(a.diffInDays(b)).toBe(0);
    expect(a.diffInDays(b, { float: true })).toBe(0.5);
    expect(b.diffInDays(a)).toBe(0);
    expect(b.diffInDays(a, { float: true })).toBe(-0.5);
  });

  it("never reports a negative zero", () => {
    const a = utc("2026-08-20T00:00:00Z");

    expect(Object.is(a.diffInDays(a), 0)).toBe(true);
    expect(Object.is(a.diffInHours(utc("2026-08-19T23:30:00Z")), 0)).toBe(true);
  });

  it("measures weeks", () => {
    expect(utc("2026-08-20").diffInWeeks(utc("2026-09-10"))).toBe(3);
    expect(utc("2026-08-20").diffInWeeks(utc("2026-08-27"), { float: true })).toBe(1);
  });

  describe("calendar units", () => {
    it("counts whole months by calendar, not by an average length", () => {
      expect(utc("2026-01-15").diffInMonths(utc("2026-04-15"))).toBe(3);
      expect(utc("2026-01-15").diffInMonths(utc("2026-04-14"))).toBe(2);
      expect(utc("2026-04-15").diffInMonths(utc("2026-01-15"))).toBe(-3);
    });

    it("treats a clamped month step as exactly one month", () => {
      // addMonths(1) maps 31 Jan onto 28 Feb, so the difference must agree.
      expect(utc("2026-01-31").diffInMonths(utc("2026-02-28"))).toBe(1);
    });

    it("counts quarters and years", () => {
      expect(utc("2026-01-15").diffInQuarters(utc("2026-10-15"))).toBe(3);
      expect(utc("2026-08-20").diffInYears(utc("2030-08-20"))).toBe(4);
      expect(utc("2026-08-20").diffInYears(utc("2030-08-19"))).toBe(3);
    });

    it("computes an age the way plan §31 wants it to read", () => {
      const birthday = utc("1990-06-15");
      expect(birthday.diffInYears(utc("2026-06-14"))).toBe(35);
      expect(birthday.diffInYears(utc("2026-06-15"))).toBe(36);
    });

    it("produces a fraction of the partial unit", () => {
      // Half of a 31-day January.
      const half = utc("2026-01-01").diffInMonths(utc("2026-01-16T12:00:00Z"), { float: true });
      expect(half).toBeCloseTo(0.5, 5);
    });
  });

  describe("elapsed time versus calendar distance (plan §10)", () => {
    // Across the US spring-forward, midnight to midnight is one calendar day
    // but only 23 real hours. Both answers are correct; the API returns each
    // from the method that asks that question.
    const before = DateTime.parse("2026-03-08T00:00:00", "America/New_York");
    const after = DateTime.parse("2026-03-09T00:00:00", "America/New_York");

    it("reports one calendar day", () => {
      expect(before.diffInDays(after)).toBe(1);
    });

    it("reports twenty-three elapsed hours", () => {
      expect(before.diffInHours(after)).toBe(23);
    });

    it("agrees with the raw instant difference", () => {
      expect(after.epochMilliseconds - before.epochMilliseconds).toBe(23 * 3_600_000);
    });
  });

  it("returns an exact Duration from diff()", () => {
    const duration = utc("2026-08-20T00:00:00Z").diff(utc("2026-08-22T06:00:00Z"));

    expect(duration.totalHours).toBe(54);
    expect(duration.isExact).toBe(true);
  });

  it("returns a negative Duration when the argument is earlier", () => {
    const duration = utc("2026-08-22T00:00:00Z").diff(utc("2026-08-20T00:00:00Z"));

    expect(duration.totalHours).toBe(-48);
    expect(duration.isNegative).toBe(true);
  });
});
