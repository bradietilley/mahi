import { afterEach, describe, expect, it } from "vitest";

import { getDefaultTimezone, resetDefaultTimezone, setDefaultTimezone } from "../../src/config.js";
import { DateTime } from "../../src/date-time.js";
import { InvalidTimezoneError } from "../../src/errors.js";
import { Timezone } from "../../src/timezone.js";

afterEach(() => setDefaultTimezone("UTC"));

describe("edge cases", () => {
  it("handles the Unix epoch itself", () => {
    const epoch = DateTime.fromTimestamp(0, "UTC");

    expect(epoch.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(epoch.unixTimestamp).toBe(0);
    expect(epoch.subMilliseconds(1).toISOString()).toBe("1969-12-31T23:59:59.999Z");
  });

  it("handles pre-epoch instants and their negative timestamps", () => {
    const date = DateTime.create(1969, 7, 20, 20, 17, 40, 0, "UTC");

    expect(date.epochMilliseconds).toBeLessThan(0);
    expect(date.toISOString()).toBe("1969-07-20T20:17:40.000Z");
    expect(date.unixTimestamp).toBe(-14_182_940);
    expect(date.addDays(1).toISODate()).toBe("1969-07-21");
  });

  it("handles years below 1000 without dropping padding", () => {
    const date = DateTime.create(50, 3, 15, 12, 0, 0, 0, "UTC");

    // Date.UTC maps years 0-99 into the 1900s; this package must not.
    expect(date.year).toBe(50);
    expect(date.toISODate()).toBe("0050-03-15");
  });

  it("handles far-future dates", () => {
    const date = DateTime.create(2999, 12, 31, 23, 59, 59, 999, "UTC");

    expect(date.addMilliseconds(1).toISOString()).toBe("3000-01-01T00:00:00.000Z");
    expect(date.addYears(1).year).toBe(3000);
  });

  it("survives midnight and end-of-day round trips", () => {
    const midnight = DateTime.create(2026, 8, 20, 0, 0, 0, 0, "Australia/Perth");

    expect(midnight.startOfDay().isEqual(midnight)).toBe(true);
    expect(midnight.endOfDay().addMilliseconds(1).isEqual(midnight.addDays(1))).toBe(true);
  });

  it("crosses century and leap-century boundaries", () => {
    expect(DateTime.parse("2099-12-31T23:59:59Z", "UTC").addSeconds(1).toISODate()).toBe(
      "2100-01-01",
    );
    // 2100 is not a leap year; 2000 was.
    expect(DateTime.parse("2100-02-28", "UTC").addDays(1).toISODate()).toBe("2100-03-01");
    expect(DateTime.parse("2000-02-28", "UTC").addDays(1).toISODate()).toBe("2000-02-29");
  });

  it("handles a zero-length and a huge arithmetic step", () => {
    const date = DateTime.parse("2026-08-20T12:00:00Z", "UTC");

    expect(date.addDays(0).isEqual(date)).toBe(true);
    expect(date.addMonths(0).isEqual(date)).toBe(true);
    expect(date.addYears(1000).year).toBe(3026);
    expect(date.subYears(1000).year).toBe(1026);
  });

  it("counts week boundaries across a year boundary", () => {
    // 31 December 2026 is a Thursday, so its ISO week runs into 2027.
    const newYearsEve = DateTime.parse("2026-12-31T12:00:00Z", "UTC");

    expect(newYearsEve.startOfWeek().toISODate()).toBe("2026-12-28");
    expect(newYearsEve.endOfWeek().toISODate()).toBe("2027-01-03");
  });

  describe("default timezone", () => {
    it("is used by factories that are not given one", () => {
      setDefaultTimezone("Australia/Perth");

      expect(DateTime.now().timezone).toBe("Australia/Perth");
      expect(DateTime.parse("2026-08-20T00:00:00").utc().toISOString()).toBe(
        "2026-08-19T16:00:00.000Z",
      );
    });

    it("does not retroactively move an already-constructed instant", () => {
      const before = DateTime.parse("2026-08-20T12:00:00Z", "Europe/London");
      const instant = before.epochMilliseconds;

      setDefaultTimezone("Asia/Tokyo");

      expect(before.timezone).toBe("Europe/London");
      expect(before.epochMilliseconds).toBe(instant);
    });

    it("rejects an invalid default", () => {
      expect(() => setDefaultTimezone("Not/AZone")).toThrow(InvalidTimezoneError);
      expect(getDefaultTimezone()).toBe("UTC");
    });

    it("falls back to the host zone when reset", () => {
      resetDefaultTimezone();
      expect(getDefaultTimezone()).toBe(Timezone.system());
    });
  });
});
