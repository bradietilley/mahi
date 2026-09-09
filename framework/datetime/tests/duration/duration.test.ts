import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";
import { InvalidDurationError } from "../../src/errors.js";

describe("Duration", () => {
  describe("construction", () => {
    it("builds from each unit", () => {
      expect(Duration.milliseconds(500).totalMilliseconds).toBe(500);
      expect(Duration.seconds(90).totalMinutes).toBe(1.5);
      expect(Duration.minutes(90).totalHours).toBe(1.5);
      expect(Duration.hours(36).totalDays).toBe(1.5);
      expect(Duration.days(14).totalWeeks).toBe(2);
    });

    it("folds years and quarters into months, and weeks into days", () => {
      expect(Duration.years(2).months).toBe(24);
      expect(Duration.quarters(3).months).toBe(9);
      expect(Duration.weeks(2).days).toBe(14);
    });

    it("builds from an object", () => {
      const duration = Duration.from({ years: 1, months: 2, weeks: 1, days: 3, hours: 4 });

      expect(duration.months).toBe(14);
      expect(duration.days).toBe(10);
      expect(duration.milliseconds).toBe(4 * 3_600_000);
    });

    it("returns the same instance when given a Duration", () => {
      const duration = Duration.hours(1);
      expect(Duration.from(duration)).toBe(duration);
    });

    it("rejects non-finite amounts", () => {
      expect(() => Duration.days(Number.NaN)).toThrow(InvalidDurationError);
      expect(() => Duration.from({ hours: Number.POSITIVE_INFINITY })).toThrow(
        InvalidDurationError,
      );
    });

    it("has a zero", () => {
      expect(Duration.zero().isZero).toBe(true);
      expect(Duration.zero().totalMilliseconds).toBe(0);
    });
  });

  describe("composition", () => {
    it("chains fluently, as plan §18 asks", () => {
      const duration = Duration.days(2).addHours(4).addMinutes(30);

      expect(duration.days).toBe(2);
      expect(duration.milliseconds).toBe(4.5 * 3_600_000);
    });

    it("adds and subtracts", () => {
      expect(Duration.hours(3).add(Duration.hours(2)).totalHours).toBe(5);
      expect(Duration.hours(3).subtract({ minutes: 30 }).totalHours).toBe(2.5);
      expect(Duration.months(3).add(Duration.months(1)).months).toBe(4);
    });

    it("multiplies and negates", () => {
      expect(Duration.hours(2).multiply(3).totalHours).toBe(6);
      expect(Duration.hours(2).negate().totalHours).toBe(-2);
      expect(Duration.hours(-2).absolute().totalHours).toBe(2);
    });

    it("compares by value", () => {
      expect(Duration.hours(1).equals(Duration.minutes(60))).toBe(true);
      expect(Duration.days(1).equals(Duration.hours(24))).toBe(false);
    });

    it("keeps a day distinct from twenty-four hours", () => {
      // They agree numerically but are different quantities: one is calendar
      // -relative when applied to a zoned DateTime, the other never is.
      expect(Duration.days(1).totalHours).toBe(24);
      expect(Duration.days(1).hasCalendarParts).toBe(true);
      expect(Duration.hours(24).hasCalendarParts).toBe(false);
    });
  });

  describe("totals", () => {
    it("treats days as 24 hours for exact-time questions", () => {
      expect(Duration.days(2).totalHours).toBe(48);
      expect(Duration.days(2).totalSeconds).toBe(172_800);
    });

    it("refuses to convert months to an exact length", () => {
      // There is no honest answer: a month is 28 to 31 days depending on
      // which month, and that isn't known without a starting date.
      expect(() => Duration.months(1).totalDays).toThrow(InvalidDurationError);
      expect(() => Duration.years(1).totalMilliseconds).toThrow(InvalidDurationError);
      expect(Duration.months(1).isExact).toBe(false);
      expect(Duration.days(30).isExact).toBe(true);
    });

    it("reports sign", () => {
      expect(Duration.hours(-3).isNegative).toBe(true);
      expect(Duration.hours(3).isNegative).toBe(false);
      expect(Duration.zero().isNegative).toBe(false);
    });
  });

  describe("ISO 8601 output", () => {
    it.each([
      [Duration.zero(), "PT0S"],
      [Duration.hours(3), "PT3H"],
      [Duration.minutes(90), "PT1H30M"],
      [Duration.seconds(45), "PT45S"],
      [Duration.milliseconds(1500), "PT1.5S"],
      [Duration.days(2), "P2D"],
      [Duration.weeks(1), "P7D"],
      [Duration.months(1), "P1M"],
      [Duration.years(1), "P1Y"],
      [Duration.years(1).addMonths(2).addDays(3).addHours(4), "P1Y2M3DT4H"],
      [Duration.hours(-3), "-PT3H"],
    ])("renders %s", (duration, expected) => {
      expect(duration.toISOString()).toBe(expected);
    });
  });

  describe("application to a DateTime", () => {
    it("applies exact parts as instant arithmetic", () => {
      const date = DateTime.parse("2026-08-20T12:00:00Z", "UTC");

      expect(date.add(Duration.hours(3)).toISOString()).toBe("2026-08-20T15:00:00.000Z");
    });

    it("applies calendar parts on the wall clock", () => {
      // Across a spring-forward, a Duration of one day advances the clock by
      // a day and the instant by 23 hours.
      const date = DateTime.parse("2026-03-07T09:00:00", "America/New_York");
      const next = date.add(Duration.days(1));

      expect(next.hour).toBe(9);
      expect(next.epochMilliseconds - date.epochMilliseconds).toBe(23 * 3_600_000);
    });

    it("differs from the equivalent exact duration across a transition", () => {
      const date = DateTime.parse("2026-03-07T09:00:00", "America/New_York");

      expect(date.add(Duration.days(1)).hour).toBe(9);
      expect(date.add(Duration.hours(24)).hour).toBe(10);
    });

    it("is produced by diff() as an exact duration", () => {
      const a = DateTime.parse("2026-08-20T12:00:00Z", "UTC");
      const b = DateTime.parse("2026-08-21T18:30:00Z", "UTC");

      expect(a.diff(b).totalHours).toBe(30.5);
      expect(a.diff(b).isExact).toBe(true);
    });
  });
});
