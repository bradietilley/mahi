import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";

describe("DateTime getters", () => {
  const date = DateTime.create(2026, 8, 20, 14, 30, 15, 250, "Australia/Perth");

  it("exposes 1-based months, never the Date off-by-one", () => {
    expect(date.month).toBe(8);
    expect(date.toArray()).toEqual([2026, 8, 20, 14, 30, 15, 250]);
  });

  it("exposes the wall-clock components of its own zone", () => {
    expect(date.year).toBe(2026);
    expect(date.day).toBe(20);
    expect(date.dayOfMonth).toBe(20);
    expect(date.hour).toBe(14);
    expect(date.minute).toBe(30);
    expect(date.second).toBe(15);
    expect(date.millisecond).toBe(250);
  });

  it("re-reads every component when the display zone changes", () => {
    const utc = date.utc();

    expect(utc.epochMilliseconds).toBe(date.epochMilliseconds);
    expect(utc.hour).toBe(6);
    expect(utc.offset).toBe(0);
    expect(date.offsetHours).toBe(8);
  });

  it("reports weekday in both conventions", () => {
    // 20 August 2026 is a Thursday.
    expect(date.dayOfWeek).toBe(4);
    expect(date.isoDayOfWeek).toBe(4);
    expect(DateTime.create(2026, 8, 23, 0, 0, 0, 0, "UTC").dayOfWeek).toBe(0);
    expect(DateTime.create(2026, 8, 23, 0, 0, 0, 0, "UTC").isoDayOfWeek).toBe(7);
  });

  it("reports day of year across a leap boundary", () => {
    expect(DateTime.create(2026, 1, 1, 0, 0, 0, 0, "UTC").dayOfYear).toBe(1);
    expect(DateTime.create(2026, 12, 31, 0, 0, 0, 0, "UTC").dayOfYear).toBe(365);
    expect(DateTime.create(2028, 12, 31, 0, 0, 0, 0, "UTC").dayOfYear).toBe(366);
  });

  it("reports quarter, days in month, and days in year", () => {
    expect(DateTime.create(2026, 1, 15, 0, 0, 0, 0, "UTC").quarter).toBe(1);
    expect(DateTime.create(2026, 8, 15, 0, 0, 0, 0, "UTC").quarter).toBe(3);
    expect(DateTime.create(2026, 12, 15, 0, 0, 0, 0, "UTC").quarter).toBe(4);

    expect(DateTime.create(2026, 2, 1, 0, 0, 0, 0, "UTC").daysInMonth).toBe(28);
    expect(DateTime.create(2028, 2, 1, 0, 0, 0, 0, "UTC").daysInMonth).toBe(29);
    expect(DateTime.create(2026, 8, 1, 0, 0, 0, 0, "UTC").daysInYear).toBe(365);
    expect(DateTime.create(2028, 8, 1, 0, 0, 0, 0, "UTC").daysInYear).toBe(366);
  });

  it("floors the unix timestamp rather than rounding it", () => {
    const withMillis = DateTime.fromTimestamp(1_500, "UTC");

    expect(withMillis.timestamp).toBe(1_500);
    expect(withMillis.unixTimestamp).toBe(1);
  });

  it("computes ISO week numbers independently of the configured week start", () => {
    // 1 January 2027 is a Friday, so ISO puts it in week 53 of 2026.
    const newYear = DateTime.create(2027, 1, 1, 0, 0, 0, 0, "UTC");

    expect(newYear.isoWeek).toBe(53);
    expect(newYear.isoWeekYear).toBe(2026);
  });

  it("honours weekStartsOn for the locale-independent week number", () => {
    const date = DateTime.create(2026, 1, 4, 0, 0, 0, 0, "UTC"); // a Sunday

    expect(date.week({ weekStartsOn: 0 })).toBe(2);
    expect(date.week({ weekStartsOn: 1 })).toBe(1);
  });

  it("identifies leap years by the Gregorian rule, including the century case", () => {
    expect(DateTime.create(2024, 1, 1, 0, 0, 0, 0, "UTC").isLeapYear()).toBe(true);
    expect(DateTime.create(1900, 1, 1, 0, 0, 0, 0, "UTC").isLeapYear()).toBe(false);
    expect(DateTime.create(2000, 1, 1, 0, 0, 0, 0, "UTC").isLeapYear()).toBe(true);
  });

  it("classifies weekdays and weekends", () => {
    const saturday = DateTime.create(2026, 8, 22, 0, 0, 0, 0, "UTC");
    const monday = DateTime.create(2026, 8, 24, 0, 0, 0, 0, "UTC");

    expect(saturday.isSaturday()).toBe(true);
    expect(saturday.isWeekend()).toBe(true);
    expect(saturday.isWeekday()).toBe(false);
    expect(monday.isMonday()).toBe(true);
    expect(monday.isWeekday()).toBe(true);
  });

  it("finds the next and previous occurrence of a weekday", () => {
    const thursday = DateTime.create(2026, 8, 20, 14, 0, 0, 0, "UTC");

    // Never returns the same day, even when the weekday matches.
    expect(thursday.next(4).toISODate()).toBe("2026-08-27");
    expect(thursday.previous(4).toISODate()).toBe("2026-08-13");
    expect(thursday.next(1).toISODate()).toBe("2026-08-24");
    expect(thursday.previous(1).toISODate()).toBe("2026-08-17");
  });

  it("detects the first and last day of a month", () => {
    expect(DateTime.create(2026, 2, 1, 0, 0, 0, 0, "UTC").isFirstDayOfMonth()).toBe(true);
    expect(DateTime.create(2026, 2, 28, 0, 0, 0, 0, "UTC").isLastDayOfMonth()).toBe(true);
    expect(DateTime.create(2028, 2, 28, 0, 0, 0, 0, "UTC").isLastDayOfMonth()).toBe(false);
  });
});
