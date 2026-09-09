import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("DateTime arithmetic", () => {
  it("adds and subtracts exact units", () => {
    const date = utc("2026-08-20T14:30:15.250Z");

    expect(date.addMilliseconds(750).toISOString()).toBe("2026-08-20T14:30:16.000Z");
    expect(date.addSeconds(45).toISOString()).toBe("2026-08-20T14:31:00.250Z");
    expect(date.addMinutes(30).toISOString()).toBe("2026-08-20T15:00:15.250Z");
    expect(date.addHours(10).toISOString()).toBe("2026-08-21T00:30:15.250Z");
  });

  it("adds and subtracts calendar units", () => {
    const date = utc("2026-08-20T14:30:00Z");

    expect(date.addDays(1).toISODate()).toBe("2026-08-21");
    expect(date.addWeeks(2).toISODate()).toBe("2026-09-03");
    expect(date.addMonths(1).toISODate()).toBe("2026-09-20");
    expect(date.addQuarters(1).toISODate()).toBe("2026-11-20");
    expect(date.addYears(1).toISODate()).toBe("2027-08-20");
  });

  it("mirrors every add with a sub", () => {
    const date = utc("2026-08-20T14:30:00Z");

    expect(date.subDays(1).toISODate()).toBe("2026-08-19");
    expect(date.subWeeks(1).toISODate()).toBe("2026-08-13");
    expect(date.subMonths(1).toISODate()).toBe("2026-07-20");
    expect(date.subQuarters(1).toISODate()).toBe("2026-05-20");
    expect(date.subYears(1).toISODate()).toBe("2025-08-20");
    expect(date.subHours(2).toISOString()).toBe("2026-08-20T12:30:00.000Z");
  });

  describe("month-boundary edge cases (plan §7)", () => {
    it("clamps 31 January + 1 month to the end of February", () => {
      expect(utc("2026-01-31").addMonths(1).toISODate()).toBe("2026-02-28");
      expect(utc("2028-01-31").addMonths(1).toISODate()).toBe("2028-02-29");
    });

    it("is deliberately not reversible at a clamped boundary", () => {
      // 31 Jan → 28 Feb → 28 Jan. The information is genuinely lost; every
      // library that clamps behaves this way, and pretending otherwise would
      // require carrying hidden state.
      expect(utc("2026-01-31").addMonths(1).subMonths(1).toISODate()).toBe("2026-01-28");
    });

    it("clamps 29 February + 1 year to 28 February", () => {
      expect(utc("2028-02-29").addYears(1).toISODate()).toBe("2029-02-28");
      expect(utc("2028-02-29").addYears(4).toISODate()).toBe("2032-02-29");
    });

    it("keeps 31 March + 1 month at 30 April", () => {
      expect(utc("2026-03-31").addMonths(1).toISODate()).toBe("2026-04-30");
    });

    it("preserves the time of day through a clamp", () => {
      expect(utc("2026-01-31T23:59:59.999Z").addMonths(1).toISOString()).toBe(
        "2026-02-28T23:59:59.999Z",
      );
    });

    it("rolls over year boundaries", () => {
      expect(utc("2026-12-31").addDays(1).toISODate()).toBe("2027-01-01");
      expect(utc("2027-01-01").subDays(1).toISODate()).toBe("2026-12-31");
      expect(utc("2026-11-30").addMonths(2).toISODate()).toBe("2027-01-30");
    });
  });

  describe("Duration application", () => {
    it("accepts a Duration", () => {
      const date = utc("2026-08-20T14:30:00Z");

      expect(date.add(Duration.hours(3)).toISOString()).toBe("2026-08-20T17:30:00.000Z");
      expect(date.subtract(Duration.days(2)).toISODate()).toBe("2026-08-18");
    });

    it("accepts a plain object", () => {
      expect(utc("2026-08-20T00:00:00Z").add({ days: 1, hours: 6 }).toISOString()).toBe(
        "2026-08-21T06:00:00.000Z",
      );
    });

    it("applies buckets largest-first, which matters at a clamp", () => {
      // Months first (31 Jan → 28 Feb), then days (→ 1 Mar). Applying the day
      // first would give 1 Feb → 1 Mar, which is the same here but diverges
      // for longer offsets; the order is fixed so the behaviour is stable.
      expect(utc("2026-01-31").add({ months: 1, days: 1 }).toISODate()).toBe("2026-03-01");
    });

    it("handles a composed multi-unit duration", () => {
      const duration = Duration.days(2).addHours(4).addMinutes(30);

      expect(utc("2026-08-20T00:00:00Z").add(duration).toISOString()).toBe(
        "2026-08-22T04:30:00.000Z",
      );
    });

    it("round-trips add and subtract for exact durations", () => {
      const date = utc("2026-08-20T14:30:00Z");
      const duration = Duration.hours(37).addMinutes(12);

      expect(date.add(duration).subtract(duration).isEqual(date)).toBe(true);
    });
  });

  describe("field replacement", () => {
    it("replaces individual fields", () => {
      const date = utc("2026-08-20T14:30:15.250Z");

      expect(date.withYear(2030).toISODate()).toBe("2030-08-20");
      expect(date.withMonth(1).toISODate()).toBe("2026-01-20");
      expect(date.withDay(1).toISODate()).toBe("2026-08-01");
      expect(date.withHour(0).toISOString()).toBe("2026-08-20T00:30:15.250Z");
      expect(date.withMinute(0).toISOString()).toBe("2026-08-20T14:00:15.250Z");
      expect(date.withSecond(0).toISOString()).toBe("2026-08-20T14:30:00.250Z");
      expect(date.withMillisecond(0).toISOString()).toBe("2026-08-20T14:30:15.000Z");
    });

    it("replaces several fields at once", () => {
      expect(
        utc("2026-08-20T14:30:15.250Z")
          .with({ hour: 0, minute: 0, second: 0, millisecond: 0 })
          .toISOString(),
      ).toBe("2026-08-20T00:00:00.000Z");
    });

    it("rejects a replacement that produces an impossible date", () => {
      // 31 August exists; 31 February does not, and silently sliding to
      // 3 March would be worse than an error.
      expect(() => utc("2026-08-31").withMonth(2)).toThrow();
    });
  });
});
