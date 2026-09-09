import { afterEach, describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { InvalidDateTimeError, InvalidTimezoneError } from "../../src/errors.js";

afterEach(() => DateTime.setTestNow(null));

describe("DateTime construction", () => {
  it("builds from components interpreted in an explicit zone", () => {
    const date = DateTime.create(2026, 8, 20, 14, 30, 0, 0, "Australia/Perth");

    expect(date.toISOString()).toBe("2026-08-20T14:30:00.000+08:00");
    // Perth is UTC+8 year-round, so the instant is six-thirty in the morning UTC.
    expect(date.utc().toISOString()).toBe("2026-08-20T06:30:00.000Z");
  });

  it("rejects out-of-range components rather than rolling them over", () => {
    expect(() => DateTime.create(2026, 2, 30, 0, 0, 0, 0, "UTC")).toThrow(InvalidDateTimeError);
    expect(() => DateTime.create(2026, 13, 1, 0, 0, 0, 0, "UTC")).toThrow(InvalidDateTimeError);
    expect(() => DateTime.create(2026, 1, 1, 24, 0, 0, 0, "UTC")).toThrow(InvalidDateTimeError);
  });

  it("accepts 29 February only in a leap year", () => {
    expect(DateTime.create(2028, 2, 29, 0, 0, 0, 0, "UTC").day).toBe(29);
    expect(DateTime.createSafe(2026, 2, 29, 0, 0, 0, 0, "UTC")).toBeNull();
  });

  it("createSafe returns null where create throws", () => {
    expect(DateTime.createSafe(2026, 2, 30, 0, 0, 0, 0, "UTC")).toBeNull();
    expect(DateTime.createSafe(2026, 2, 28, 0, 0, 0, 0, "UTC")).toBeInstanceOf(DateTime);
  });

  it("rejects unknown timezones", () => {
    expect(() => DateTime.now("Mars/Olympus_Mons")).toThrow(InvalidTimezoneError);
  });

  it("adopts the instant of a native Date without keeping the Date", () => {
    const native = new Date("2026-08-20T06:30:00.000Z");
    const date = DateTime.fromDate(native, "Australia/Perth");

    native.setUTCFullYear(1999);

    expect(date.year).toBe(2026);
    expect(date.hour).toBe(14);
  });

  it("refuses an Invalid Date instead of propagating NaN", () => {
    expect(() => DateTime.fromDate(new Date("nonsense"))).toThrow(InvalidDateTimeError);
  });

  it("builds from millisecond and second timestamps", () => {
    expect(DateTime.fromTimestamp(0, "UTC").toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(DateTime.fromUnixTimestamp(86_400, "UTC").toISODate()).toBe("1970-01-02");
  });

  it("rejects non-finite timestamps", () => {
    expect(() => DateTime.fromTimestamp(Number.NaN)).toThrow(InvalidDateTimeError);
    expect(() => DateTime.fromTimestamp(Number.POSITIVE_INFINITY)).toThrow(InvalidDateTimeError);
  });

  it("derives today/yesterday/tomorrow from the frozen clock", () => {
    DateTime.setTestNow(DateTime.create(2026, 8, 20, 14, 30, 0, 0, "UTC"));

    expect(DateTime.today("UTC").toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(DateTime.yesterday("UTC").toISODate()).toBe("2026-08-19");
    expect(DateTime.tomorrow("UTC").toISODate()).toBe("2026-08-21");
  });

  it("freezes now() so repeated reads agree", () => {
    DateTime.setTestNow("2026-08-20T06:30:00Z");

    expect(DateTime.hasTestNow()).toBe(true);
    expect(DateTime.now("UTC").toISOString()).toBe("2026-08-20T06:30:00.000Z");
    expect(DateTime.now("UTC").toISOString()).toBe("2026-08-20T06:30:00.000Z");
  });

  it("resolves today() in the requested zone, not the default one", () => {
    // 08:00 UTC is already the 21st in Sydney but still the 20th in London.
    DateTime.setTestNow("2026-08-20T22:00:00Z");

    expect(DateTime.today("Australia/Sydney").toISODate()).toBe("2026-08-21");
    expect(DateTime.today("Europe/London").toISODate()).toBe("2026-08-20");
  });

  describe("Carbon-named factories", () => {
    it("keeps the current time of day in createFromDate, as Carbon does", () => {
      DateTime.setTestNow("2026-08-20T14:30:45.123Z");

      // Surprising, and faithfully so: this is not midnight.
      expect(DateTime.createFromDate(2027, 1, 2, "UTC").toISOString()).toBe(
        "2027-01-02T14:30:45.123Z",
      );
      // The unsurprising one has a name that says what it does.
      expect(DateTime.createMidnightDate(2027, 1, 2, "UTC").toISOString()).toBe(
        "2027-01-02T00:00:00.000Z",
      );
    });

    it("keeps today's date in createFromTime", () => {
      DateTime.setTestNow("2026-08-20T14:30:45.123Z");

      expect(DateTime.createFromTime(6, 15, 0, 0, "UTC").toISOString()).toBe(
        "2026-08-20T06:15:00.000Z",
      );
    });

    it("distinguishes second and millisecond timestamps by name", () => {
      expect(DateTime.createFromTimestamp(1_787_236_200, "UTC").toISOString()).toBe(
        "2026-08-20T14:30:00.000Z",
      );
      expect(DateTime.createFromTimestampMs(1_787_236_200_000, "UTC").toISOString()).toBe(
        "2026-08-20T14:30:00.000Z",
      );
    });

    it("adopts a native Date via instance()", () => {
      const native = new Date("2026-08-20T14:30:00Z");

      expect(DateTime.instance(native, "UTC").toISOString()).toBe("2026-08-20T14:30:00.000Z");
      expect(() => DateTime.instance(new Date(Number.NaN))).toThrow(InvalidDateTimeError);
    });
  });
});
