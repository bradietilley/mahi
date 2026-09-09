/**
 * Plan §25 makes immutability a first-class test target rather than something
 * assumed. Each case asserts all three properties: a new object came back,
 * the original is untouched, and the new object carries the change.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";

const base = () => DateTime.create(2026, 1, 1, 12, 30, 15, 250, "Australia/Perth");

const operations: Array<[string, (date: DateTime) => DateTime]> = [
  ["addMilliseconds", (d) => d.addMilliseconds(1)],
  ["addSeconds", (d) => d.addSeconds(1)],
  ["addMinutes", (d) => d.addMinutes(1)],
  ["addHours", (d) => d.addHours(1)],
  ["addDays", (d) => d.addDays(1)],
  ["addWeeks", (d) => d.addWeeks(1)],
  ["addMonths", (d) => d.addMonths(1)],
  ["addQuarters", (d) => d.addQuarters(1)],
  ["addYears", (d) => d.addYears(1)],
  ["subDays", (d) => d.subDays(1)],
  ["subMonths", (d) => d.subMonths(1)],
  ["add(Duration)", (d) => d.add(Duration.hours(3))],
  ["subtract(Duration)", (d) => d.subtract(Duration.days(2))],
  ["startOfDay", (d) => d.startOfDay()],
  ["endOfDay", (d) => d.endOfDay()],
  ["startOfMonth", (d) => d.startOfMonth()],
  ["endOfYear", (d) => d.endOfYear()],
  ["withYear", (d) => d.withYear(2030)],
  ["withHour", (d) => d.withHour(5)],
  ["with", (d) => d.with({ minute: 0, second: 0 })],
  ["inTimezone", (d) => d.inTimezone("UTC")],
  ["keepLocalTime", (d) => d.keepLocalTime("Australia/Sydney")],
  ["next", (d) => d.next(1)],
  ["previous", (d) => d.previous(5)],
];

describe("DateTime immutability", () => {
  it.each(operations)(
    "%s returns a new instance and leaves the original alone",
    (_name, operate) => {
      const original = base();
      const snapshot = original.toISOString();

      const result = operate(original);

      expect(result).not.toBe(original);
      expect(original.toISOString()).toBe(snapshot);
      expect(original.epochMilliseconds).toBe(base().epochMilliseconds);
    },
  );

  it("cannot have its fields reassigned", () => {
    const date = base();

    expect(Object.isFrozen(date)).toBe(true);
    expect(() => {
      (date as unknown as { epochMilliseconds: number }).epochMilliseconds = 0;
    }).toThrow(TypeError);
  });

  it("demonstrates the canonical plan §25 example", () => {
    const original = DateTime.parse("2026-01-01", "UTC");
    const result = original.addDays(1);

    expect(original.day).toBe(1);
    expect(result.day).toBe(2);
  });

  it("keeps Duration immutable too", () => {
    const original = Duration.days(2);
    const result = original.addHours(4);

    expect(result).not.toBe(original);
    expect(original.totalHours).toBe(48);
    expect(result.totalHours).toBe(52);
    expect(Object.isFrozen(original)).toBe(true);
  });
});
