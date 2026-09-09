/**
 * Plan §16/§17 plus the Carbon-parity conveniences from §23.
 *
 * The interesting assertions here are the ones that pin a *choice*: which
 * years a century spans, that `nthOfMonth` refuses to spill into the next
 * month, and that the overflowing month arithmetic really does disagree with
 * the clamping default.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("calendar accessors", () => {
  it("reports the ordinal century, not the 'the 2000s' reading", () => {
    // 2000 belongs to the 20th century; 2001 starts the 21st. The two
    // readings disagree for exactly one year in a hundred, so it is pinned.
    expect(utc("2000-06-01T00:00:00Z").century).toBe(20);
    expect(utc("2001-06-01T00:00:00Z").century).toBe(21);
    expect(utc("2026-06-01T00:00:00Z").century).toBe(21);
  });

  it("reports week-of-month as a seven-day block", () => {
    expect(utc("2026-08-07T00:00:00Z").weekOfMonth).toBe(1);
    expect(utc("2026-08-08T00:00:00Z").weekOfMonth).toBe(2);
    expect(utc("2026-08-31T00:00:00Z").weekOfMonth).toBe(5);
  });

  it("counts ISO weeks in the year", () => {
    // 2026 is a long ISO year (53 weeks); 2025 is not.
    expect(utc("2026-06-01T00:00:00Z").isoWeeksInYear()).toBe(53);
    expect(utc("2026-06-01T00:00:00Z").isLongYear()).toBe(true);
    expect(utc("2025-06-01T00:00:00Z").isoWeeksInYear()).toBe(52);
    expect(utc("2025-06-01T00:00:00Z").isLongYear()).toBe(false);
  });

  it("computes age against the frozen clock", () => {
    DateTime.setTestNow("2026-08-20T12:00:00Z");

    expect(utc("1990-08-20T00:00:00Z").age).toBe(36);
    // The day before the birthday is still the previous age.
    expect(utc("1990-08-21T00:00:00Z").age).toBe(35);
  });
});

describe("extended boundaries", () => {
  it("bounds decades on the round year", () => {
    const date = utc("2026-08-20T12:00:00Z");

    expect(date.startOfDecade().toISODate()).toBe("2020-01-01");
    expect(date.endOfDecade().toISOString()).toBe("2029-12-31T23:59:59.999Z");
  });

  it("bounds centuries on the ordinal boundary", () => {
    const date = utc("2026-08-20T12:00:00Z");

    expect(date.startOfCentury().toISODate()).toBe("2001-01-01");
    expect(date.endOfCentury().toISOString()).toBe("2100-12-31T23:59:59.999Z");
    expect(utc("2000-08-20T12:00:00Z").startOfCentury().toISODate()).toBe("1901-01-01");
  });

  it("floors, ceils, and rounds to a unit", () => {
    const date = utc("2026-08-20T12:34:56.789Z");

    expect(date.floor("hour").toISOString()).toBe("2026-08-20T12:00:00.000Z");
    expect(date.ceil("hour").toISOString()).toBe("2026-08-20T13:00:00.000Z");
    expect(date.round("hour").toISOString()).toBe("2026-08-20T13:00:00.000Z");
    expect(utc("2026-08-20T12:20:00Z").round("hour").toISOString()).toBe(
      "2026-08-20T12:00:00.000Z",
    );
  });

  it("leaves a value already on a boundary alone when ceiling", () => {
    const exact = utc("2026-08-20T12:00:00.000Z");
    expect(exact.ceil("hour").isEqual(exact)).toBe(true);
  });

  it("rounds a midpoint upward", () => {
    expect(utc("2026-08-20T12:30:00.000Z").round("hour").toISOString()).toBe(
      "2026-08-20T13:00:00.000Z",
    );
  });
});

describe("positional helpers", () => {
  it("finds the first and last day of a unit", () => {
    const date = utc("2026-08-20T12:00:00Z");

    expect(date.firstOfMonth().toISODate()).toBe("2026-08-01");
    expect(date.lastOfMonth().toISODate()).toBe("2026-08-31");
    expect(date.firstOfQuarter().toISODate()).toBe("2026-07-01");
    expect(date.lastOfQuarter().toISODate()).toBe("2026-09-30");
    expect(date.firstOfYear().toISODate()).toBe("2026-01-01");
    expect(date.lastOfYear().toISODate()).toBe("2026-12-31");
  });

  it("finds the first and last given weekday of a unit", () => {
    const date = utc("2026-08-20T12:00:00Z");

    // August 2026 starts on a Saturday; the first Monday is the 3rd.
    expect(date.firstOfMonth(1).toISODate()).toBe("2026-08-03");
    expect(date.lastOfMonth(1).toISODate()).toBe("2026-08-31");
    // 1 August is itself a Saturday, so `firstOfMonth(6)` must not skip it.
    expect(date.firstOfMonth(6).toISODate()).toBe("2026-08-01");
  });

  it("returns null for an nth weekday the month does not contain", () => {
    const date = utc("2026-08-20T12:00:00Z");

    expect(date.nthOfMonth(1, 1)?.toISODate()).toBe("2026-08-03");
    expect(date.nthOfMonth(5, 1)?.toISODate()).toBe("2026-08-31");
    // There is no sixth Monday in any month.
    expect(date.nthOfMonth(6, 1)).toBeNull();
    expect(date.nthOfMonth(0, 1)).toBeNull();
  });

  it("steps to the next and previous weekday and weekend day", () => {
    const friday = utc("2026-08-21T12:00:00Z");

    expect(friday.nextWeekday().toISODate()).toBe("2026-08-24");
    expect(friday.nextWeekendDay().toISODate()).toBe("2026-08-22");
    expect(utc("2026-08-24T12:00:00Z").previousWeekday().toISODate()).toBe("2026-08-21");
    expect(friday.previousWeekendDay().toISODate()).toBe("2026-08-16");
  });
});

describe("business days", () => {
  it("treats weekends as non-business days", () => {
    expect(utc("2026-08-21T12:00:00Z").isBusinessDay()).toBe(true);
    expect(utc("2026-08-22T12:00:00Z").isBusinessDay()).toBe(false);
    expect(utc("2026-08-23T12:00:00Z").isBusinessDay()).toBe(false);
  });

  it("accepts a different weekend", () => {
    // Friday/Saturday weekend, as observed across much of the Middle East.
    const options = { weekend: [5, 6] as const };

    expect(utc("2026-08-21T12:00:00Z").isBusinessDay(options)).toBe(false);
    expect(utc("2026-08-23T12:00:00Z").isBusinessDay(options)).toBe(true);
  });

  it("accepts a holiday predicate", () => {
    const options = { isHoliday: (date: DateTime) => date.toISODate() === "2026-08-21" };

    expect(utc("2026-08-21T12:00:00Z").isBusinessDay(options)).toBe(false);
    expect(utc("2026-08-20T12:00:00Z").addBusinessDays(1, options).toISODate()).toBe("2026-08-24");
  });

  it("skips weekends when stepping", () => {
    const friday = utc("2026-08-21T09:30:00Z");

    expect(friday.addBusinessDays(1).toISOString()).toBe("2026-08-24T09:30:00.000Z");
    expect(friday.addBusinessDays(5).toISODate()).toBe("2026-08-28");
    expect(friday.subBusinessDays(1).toISODate()).toBe("2026-08-20");
  });

  it("counts landings, so a weekend start still advances", () => {
    // Saturday + 1 business day is Monday: the starting Saturday was never a
    // business day to be counted in the first place.
    expect(utc("2026-08-22T12:00:00Z").addBusinessDays(1).toISODate()).toBe("2026-08-24");
  });

  it("preserves the time of day but normalises for next/previous", () => {
    const friday = utc("2026-08-21T09:30:00Z");

    expect(friday.nextBusinessDay().toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(friday.previousBusinessDay().toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("refuses to loop forever when no day qualifies", () => {
    expect(() => utc("2026-08-20T12:00:00Z").addBusinessDays(1, { isHoliday: () => true })).toThrow(
      /business days/,
    );
  });
});

describe("overflowing month and year arithmetic", () => {
  it("differs from the clamping default", () => {
    const january31 = utc("2026-01-31T00:00:00Z");

    expect(january31.addMonths(1).toISODate()).toBe("2026-02-28");
    expect(january31.addMonthsWithOverflow(1).toISODate()).toBe("2026-03-03");
  });

  it("overflows leap days too", () => {
    const leapDay = utc("2024-02-29T00:00:00Z");

    expect(leapDay.addYears(1).toISODate()).toBe("2025-02-28");
    expect(leapDay.addYearsWithOverflow(1).toISODate()).toBe("2025-03-01");
  });

  it("handles negative amounts and year rollover", () => {
    expect(utc("2026-03-31T00:00:00Z").subMonthsWithOverflow(1).toISODate()).toBe("2026-03-03");
    expect(utc("2026-01-15T00:00:00Z").addMonthsWithOverflow(-1).toISODate()).toBe("2025-12-15");
    expect(utc("2026-01-15T00:00:00Z").subYearsWithOverflow(1).toISODate()).toBe("2025-01-15");
  });
});

describe("unit-generic accessors", () => {
  it("reads and writes any unit by name", () => {
    const date = utc("2026-08-20T12:34:56.789Z");

    expect(date.get("year")).toBe(2026);
    expect(date.get("quarter")).toBe(3);
    expect(date.get("century")).toBe(21);
    expect(date.addUnit("month", 2).toISODate()).toBe("2026-10-20");
    expect(date.addUnit("decade", 1).toISODate()).toBe("2036-08-20");
    expect(date.subUnit("century", 1).toISODate()).toBe("1926-08-20");
    expect(date.setUnit("hour", 6).hour).toBe(6);
  });

  it("replaces whole dates and times", () => {
    const date = utc("2026-08-20T12:34:56.789Z");

    expect(date.setDate(2027, 1, 2).toISOString()).toBe("2027-01-02T12:34:56.789Z");
    expect(date.setTime(6, 15).toISOString()).toBe("2026-08-20T06:15:00.000Z");
  });
});

describe("singular aliases", () => {
  it("match their plural counterparts", () => {
    const date = utc("2026-08-20T12:00:00Z");

    expect(date.addDay().isEqual(date.addDays(1))).toBe(true);
    expect(date.subMonth().isEqual(date.subMonths(1))).toBe(true);
    expect(date.addQuarter().isEqual(date.addQuarters(1))).toBe(true);
    expect(date.subYear().isEqual(date.subYears(1))).toBe(true);
    expect(date.addWeek().isEqual(date.addWeeks(1))).toBe(true);
    expect(date.addMillisecond().isEqual(date.addMilliseconds(1))).toBe(true);
  });
});

describe("comparison conveniences", () => {
  it("clamps into a range", () => {
    const min = "2026-08-10T00:00:00Z";
    const max = "2026-08-20T00:00:00Z";

    expect(utc("2026-08-01T00:00:00Z").clamp(min, max).toISODate()).toBe("2026-08-10");
    expect(utc("2026-08-25T00:00:00Z").clamp(min, max).toISODate()).toBe("2026-08-20");
    expect(utc("2026-08-15T00:00:00Z").clamp(min, max).toISODate()).toBe("2026-08-15");
    // Bounds in either order.
    expect(utc("2026-08-01T00:00:00Z").clamp(max, min).toISODate()).toBe("2026-08-10");
  });

  it("averages instants", () => {
    expect(DateTime.average("2026-08-20T00:00:00Z", "2026-08-22T00:00:00Z").toISOString()).toBe(
      "2026-08-21T00:00:00.000Z",
    );
    expect(() => DateTime.average()).toThrow();
  });

  it("compares by an arbitrary rendering", () => {
    const a = utc("2026-08-20T09:00:00Z");

    expect(a.isSameAs("yyyy-MM", "2026-08-01T23:00:00Z")).toBe(true);
    expect(a.isSameAs("yyyy-MM-dd", "2026-08-01T23:00:00Z")).toBe(false);
  });

  it("recognises birthdays", () => {
    DateTime.setTestNow("2026-08-20T12:00:00Z");

    expect(utc("1990-08-20T00:00:00Z").isBirthday()).toBe(true);
    expect(utc("1990-08-21T00:00:00Z").isBirthday()).toBe(false);
    expect(utc("1990-08-20T00:00:00Z").isBirthday("2001-08-20T00:00:00Z")).toBe(true);
  });

  it("answers current/next/last calendar questions", () => {
    DateTime.setTestNow("2026-08-20T12:00:00Z");

    expect(utc("2026-08-20T23:00:00Z").isCurrentDay()).toBe(true);
    expect(utc("2026-08-19T00:00:00Z").isCurrentWeek()).toBe(true);
    expect(utc("2026-08-01T00:00:00Z").isCurrentMonth()).toBe(true);
    expect(utc("2026-09-01T00:00:00Z").isNextMonth()).toBe(true);
    expect(utc("2026-07-01T00:00:00Z").isLastMonth()).toBe(true);
    expect(utc("2026-08-26T00:00:00Z").isNextWeek()).toBe(true);
    expect(utc("2026-08-12T00:00:00Z").isLastWeek()).toBe(true);
    expect(utc("2027-01-01T00:00:00Z").isNextYear()).toBe(true);
    expect(utc("2025-01-01T00:00:00Z").isLastYear()).toBe(true);
    expect(utc("2026-09-01T00:00:00Z").isCurrentQuarter()).toBe(true);
  });

  it("recognises day boundaries", () => {
    expect(utc("2026-08-20T00:00:00.000Z").isStartOfDay()).toBe(true);
    expect(utc("2026-08-20T00:00:00.000Z").isMidnight()).toBe(true);
    expect(utc("2026-08-20T23:59:59.999Z").isEndOfDay()).toBe(true);
    expect(utc("2026-08-20T12:00:00.000Z").isMidday()).toBe(true);
    expect(utc("2026-08-20T12:00:00.001Z").isMidday()).toBe(false);
  });
});
