import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { InvalidFormatError } from "../../src/errors.js";

describe("parsing", () => {
  describe("ISO 8601 / RFC 3339", () => {
    it("parses a date-only string as midnight in the target zone", () => {
      expect(DateTime.parse("2026-08-20", "Australia/Perth").toISOString()).toBe(
        "2026-08-20T00:00:00.000+08:00",
      );
    });

    it("parses the space-separated form databases emit", () => {
      expect(DateTime.parse("2026-08-20 14:30:00", "UTC").toISOString()).toBe(
        "2026-08-20T14:30:00.000Z",
      );
    });

    it("parses hour-and-minute precision", () => {
      expect(DateTime.parse("2026-08-20T14:30", "UTC").toISOString()).toBe(
        "2026-08-20T14:30:00.000Z",
      );
    });

    it("parses fractional seconds and truncates below milliseconds", () => {
      expect(DateTime.parse("2026-08-20T14:30:00.123Z", "UTC").millisecond).toBe(123);
      expect(DateTime.parse("2026-08-20T14:30:00.1Z", "UTC").millisecond).toBe(100);
      // Truncated, not rounded — rounding up could roll into the next second.
      expect(DateTime.parse("2026-08-20T14:30:00.999999Z", "UTC").millisecond).toBe(999);
    });

    it("accepts a comma as the decimal separator, as ISO 8601 permits", () => {
      expect(DateTime.parse("2026-08-20T14:30:00,250Z", "UTC").millisecond).toBe(250);
    });

    it("lets an explicit offset in the string decide the instant", () => {
      // The string names its own moment; the zone argument only decides how
      // that moment is displayed afterwards.
      const date = DateTime.parse("2026-08-20T14:30:00+08:00", "America/New_York");

      expect(date.utc().toISOString()).toBe("2026-08-20T06:30:00.000Z");
      expect(date.timezone).toBe("America/New_York");
      expect(date.hour).toBe(2);
    });

    it("accepts every offset spelling", () => {
      const expected = "2026-08-20T06:30:00.000Z";

      expect(DateTime.parse("2026-08-20T14:30:00+08:00", "UTC").toISOString()).toBe(expected);
      expect(DateTime.parse("2026-08-20T14:30:00+0800", "UTC").toISOString()).toBe(expected);
      expect(DateTime.parse("2026-08-20T14:30:00+08", "UTC").toISOString()).toBe(expected);
      expect(DateTime.parse("2026-08-20T06:30:00Z", "UTC").toISOString()).toBe(expected);
      expect(DateTime.parse("2026-08-20T02:30:00-04:00", "UTC").toISOString()).toBe(expected);
    });

    it("interprets an offset-less string in the target zone", () => {
      expect(DateTime.parse("2026-08-20T14:30:00", "Australia/Perth").utc().toISOString()).toBe(
        "2026-08-20T06:30:00.000Z",
      );
    });

    it("tolerates surrounding whitespace", () => {
      expect(DateTime.parse("  2026-08-20  ", "UTC").toISODate()).toBe("2026-08-20");
    });

    describe("malformed input", () => {
      const bad = [
        "",
        "not a date",
        "2026",
        "2026-08",
        "20-08-2026",
        "2026/08/20",
        "2026-13-01",
        "2026-00-01",
        "2026-08-32",
        "2026-08-00",
        "2026-02-30",
        "2026-08-20T25:00:00",
        "2026-08-20T14:60:00",
        "2026-08-20T14:30:61",
        "2026-08-20T14:30:00+25:00",
        "2026-08-20T14:30:00 extra",
      ];

      it.each(bad)("rejects %o", (input) => {
        expect(() => DateTime.parse(input, "UTC")).toThrow(InvalidFormatError);
        expect(DateTime.parseSafe(input, "UTC")).toBeNull();
      });

      it("rejects 29 February in a common year but accepts it in a leap year", () => {
        expect(() => DateTime.parse("2026-02-29", "UTC")).toThrow(InvalidFormatError);
        expect(DateTime.parse("2028-02-29", "UTC").toISODate()).toBe("2028-02-29");
      });
    });
  });

  describe("parse() coercion", () => {
    it("accepts a DateTime, a Date, and a timestamp", () => {
      const source = DateTime.parse("2026-08-20T06:30:00Z", "UTC");

      expect(DateTime.parse(source).isEqual(source)).toBe(true);
      expect(DateTime.parse(new Date(source.epochMilliseconds), "UTC").isEqual(source)).toBe(true);
      expect(DateTime.parse(source.epochMilliseconds, "UTC").isEqual(source)).toBe(true);
    });

    it("re-displays an existing DateTime when given a zone", () => {
      const source = DateTime.parse("2026-08-20T06:30:00Z", "UTC");
      const moved = DateTime.parse(source, "Australia/Perth");

      expect(moved.isEqual(source)).toBe(true);
      expect(moved.timezone).toBe("Australia/Perth");
    });
  });

  describe("createFromFormat", () => {
    it("parses an explicit pattern", () => {
      expect(
        DateTime.createFromFormat("20/08/2026 14:30", "dd/MM/yyyy HH:mm", "UTC").toISOString(),
      ).toBe("2026-08-20T14:30:00.000Z");
    });

    it("resolves the parsed wall clock in the requested zone", () => {
      expect(
        DateTime.createFromFormat("20/08/2026 14:30", "dd/MM/yyyy HH:mm", "Australia/Perth")
          .utc()
          .toISOString(),
      ).toBe("2026-08-20T06:30:00.000Z");
    });

    it("is strict by default, rejecting dates a lenient parser would fix up", () => {
      // date-fns alone reads this as 3 March; the round-trip check catches it.
      expect(() => DateTime.createFromFormat("2026-02-31", "yyyy-MM-dd", "UTC")).toThrow(
        InvalidFormatError,
      );
    });

    it("rejects input that does not match the pattern", () => {
      expect(() => DateTime.createFromFormat("20-08-2026", "dd/MM/yyyy", "UTC")).toThrow(
        InvalidFormatError,
      );
      expect(() => DateTime.createFromFormat("gibberish", "dd/MM/yyyy", "UTC")).toThrow(
        InvalidFormatError,
      );
    });

    it("can be told to allow leniency", () => {
      expect(
        DateTime.createFromFormat("2026-2-3", "yyyy-M-d", "UTC", { strict: false }).toISODate(),
      ).toBe("2026-02-03");
    });

    it("fills unmentioned fields from today at midnight in the zone", () => {
      DateTime.setTestNow("2026-08-20T06:30:00Z");
      try {
        expect(DateTime.createFromFormat("14:30", "HH:mm", "UTC").toISOString()).toBe(
          "2026-08-20T14:30:00.000Z",
        );
      } finally {
        DateTime.setTestNow(null);
      }
    });

    it("reports a broken pattern as a programmer error, not bad input", () => {
      // `YYYY` is week-numbering year in date-fns and is almost always a typo
      // for `yyyy`; the library refuses it outright.
      expect(() => DateTime.createFromFormat("2026-08-20", "YYYY-MM-DD", "UTC")).toThrow(
        InvalidFormatError,
      );
    });
  });

  it("round-trips every format it emits", () => {
    const date = DateTime.create(2026, 8, 20, 14, 30, 45, 123, "Australia/Perth");

    expect(DateTime.parse(date.toISOString(), "Australia/Perth").isEqual(date)).toBe(true);
    expect(DateTime.parse(date.toJSON(), "Australia/Perth").isEqual(date)).toBe(true);
    expect(
      DateTime.parse(date.toDateTimeString(), "Australia/Perth").isEqual(date.startOfSecond()),
    ).toBe(true);
  });
});
