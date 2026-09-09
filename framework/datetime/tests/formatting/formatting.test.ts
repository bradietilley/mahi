import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { InvalidFormatError } from "../../src/errors.js";

describe("formatting", () => {
  const perth = DateTime.create(2026, 8, 20, 14, 30, 45, 123, "Australia/Perth");

  it("emits the standard representations", () => {
    expect(perth.toISOString()).toBe("2026-08-20T14:30:45.123+08:00");
    expect(perth.toISODate()).toBe("2026-08-20");
    expect(perth.toISOTime()).toBe("14:30:45.123");
    expect(perth.toRFC3339()).toBe("2026-08-20T14:30:45+08:00");
    expect(perth.toRFC2822()).toBe("Thu, 20 Aug 2026 14:30:45 +0800");
    expect(perth.toDateTimeString()).toBe("2026-08-20 14:30:45");
    expect(perth.toDateString()).toBe("2026-08-20");
    expect(perth.toTimeString()).toBe("14:30:45");
  });

  it("uses Z rather than +00:00 for UTC", () => {
    expect(perth.utc().toISOString()).toBe("2026-08-20T06:30:45.123Z");
  });

  it("formats in the instance's own zone, not the host's", () => {
    const instant = "2026-08-20T06:30:45.123Z";

    expect(DateTime.parse(instant, "Australia/Perth").format("yyyy-MM-dd HH:mm")).toBe(
      "2026-08-20 14:30",
    );
    expect(DateTime.parse(instant, "America/New_York").format("yyyy-MM-dd HH:mm")).toBe(
      "2026-08-20 02:30",
    );
    expect(DateTime.parse(instant, "UTC").format("yyyy-MM-dd HH:mm")).toBe("2026-08-20 06:30");
  });

  it("supports arbitrary patterns", () => {
    expect(perth.format("EEEE, d MMMM yyyy")).toBe("Thursday, 20 August 2026");
    expect(perth.format("HH:mm:ss.SSS")).toBe("14:30:45.123");
    expect(perth.format("QQQ yyyy")).toBe("Q3 2026");
    expect(perth.format("'week' II")).toBe("week 34");
  });

  it("renders the offset token for the right zone and season", () => {
    expect(DateTime.parse("2026-01-15T12:00:00", "America/New_York").format("xxx")).toBe("-05:00");
    expect(DateTime.parse("2026-07-15T12:00:00", "America/New_York").format("xxx")).toBe("-04:00");
    expect(DateTime.parse("2026-07-15T12:00:00", "Asia/Kolkata").format("xxx")).toBe("+05:30");
  });

  it("pads years, months, and days", () => {
    expect(DateTime.create(9, 1, 2, 3, 4, 5, 6, "UTC").toISOString()).toBe(
      "0009-01-02T03:04:05.006Z",
    );
  });

  it("rejects a pattern that misuses a protected token", () => {
    // `DD` is day-of-year and `YYYY` is week-numbering year; both are almost
    // always typos for `dd`/`yyyy`, and both are pattern bugs rather than
    // data problems, so they surface as InvalidFormatError.
    expect(() => perth.format("YYYY-MM-dd")).toThrow(InvalidFormatError);
    expect(() => perth.format("yyyy-MM-DD")).toThrow(InvalidFormatError);
  });

  it("formats the Unix epoch and far-future dates", () => {
    expect(DateTime.fromTimestamp(0, "UTC").toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(DateTime.create(2999, 12, 31, 23, 59, 59, 999, "UTC").toISOString()).toBe(
      "2999-12-31T23:59:59.999Z",
    );
    expect(DateTime.create(1899, 6, 15, 12, 0, 0, 0, "UTC").toISODate()).toBe("1899-06-15");
  });

  it("renders readably for humans and debuggers", () => {
    expect(String(perth)).toBe("2026-08-20T14:30:45.123+08:00");
    expect(`${perth}`).toBe("2026-08-20T14:30:45.123+08:00");
  });
});
