import { describe, expect, it } from "vitest";
import {
  InvalidCronExpressionError,
  isCronDue,
  nextCronRun,
  parseCronExpression,
  validateCronExpression,
} from "../src/cron-matcher.js";

describe("isCronDue", () => {
  it("'* * * * *' is always due", () => {
    expect(isCronDue("* * * * *", new Date(2026, 0, 1, 13, 37))).toBe(true);
    expect(isCronDue("* * * * *", new Date(2026, 5, 15, 0, 0))).toBe(true);
  });

  it("'*/5 * * * *' is due only on multiples of 5", () => {
    expect(isCronDue("*/5 * * * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(isCronDue("*/5 * * * *", new Date(2026, 0, 1, 0, 5))).toBe(true);
    expect(isCronDue("*/5 * * * *", new Date(2026, 0, 1, 0, 10))).toBe(true);
    expect(isCronDue("*/5 * * * *", new Date(2026, 0, 1, 0, 1))).toBe(false);
    expect(isCronDue("*/5 * * * *", new Date(2026, 0, 1, 0, 4))).toBe(false);
  });

  it("'0 0 * * *' is due only at midnight", () => {
    expect(isCronDue("0 0 * * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(isCronDue("0 0 * * *", new Date(2026, 0, 1, 0, 1))).toBe(false);
    expect(isCronDue("0 0 * * *", new Date(2026, 0, 1, 1, 0))).toBe(false);
  });

  it("'0 * * * *' is due once every hour, at minute 0", () => {
    expect(isCronDue("0 * * * *", new Date(2026, 0, 1, 5, 0))).toBe(true);
    expect(isCronDue("0 * * * *", new Date(2026, 0, 1, 5, 30))).toBe(false);
  });

  it("comma lists match any listed value", () => {
    expect(isCronDue("1,15,30 * * * *", new Date(2026, 0, 1, 0, 1))).toBe(true);
    expect(isCronDue("1,15,30 * * * *", new Date(2026, 0, 1, 0, 15))).toBe(true);
    expect(isCronDue("1,15,30 * * * *", new Date(2026, 0, 1, 0, 30))).toBe(true);
    expect(isCronDue("1,15,30 * * * *", new Date(2026, 0, 1, 0, 2))).toBe(false);
  });

  it("ranges match any value within the inclusive bounds", () => {
    // Weekdays (Mon-Fri) at midnight. 2026-01-05 is a Monday.
    expect(isCronDue("0 0 * * 1-5", new Date(2026, 0, 5, 0, 0))).toBe(true); // Mon
    expect(isCronDue("0 0 * * 1-5", new Date(2026, 0, 9, 0, 0))).toBe(true); // Fri
    expect(isCronDue("0 0 * * 1-5", new Date(2026, 0, 10, 0, 0))).toBe(false); // Sat
    expect(isCronDue("0 0 * * 1-5", new Date(2026, 0, 4, 0, 0))).toBe(false); // Sun
  });

  it("ranges with a step match every nth value within the bounds", () => {
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 10))).toBe(true);
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 30))).toBe(true);
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 20))).toBe(true);
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 5))).toBe(false);
    expect(isCronDue("0-30/10 * * * *", new Date(2026, 0, 1, 0, 40))).toBe(false);
  });

  it("comma lists mix single values, ranges, and stepped ranges", () => {
    expect(isCronDue("1,15-17,30-40/5 * * * *", new Date(2026, 0, 1, 0, 1))).toBe(true);
    expect(isCronDue("1,15-17,30-40/5 * * * *", new Date(2026, 0, 1, 0, 16))).toBe(true);
    expect(isCronDue("1,15-17,30-40/5 * * * *", new Date(2026, 0, 1, 0, 35))).toBe(true);
    expect(isCronDue("1,15-17,30-40/5 * * * *", new Date(2026, 0, 1, 0, 18))).toBe(false);
    expect(isCronDue("1,15-17,30-40/5 * * * *", new Date(2026, 0, 1, 0, 32))).toBe(false);
  });

  it("throws on an inverted range", () => {
    expect(() => isCronDue("5-1 * * * *", new Date())).toThrow();
  });

  it("'0 0 * * 0' (weekly) is due only on Sundays at midnight", () => {
    // 2026-01-04 is a Sunday
    expect(isCronDue("0 0 * * 0", new Date(2026, 0, 4, 0, 0))).toBe(true);
    expect(isCronDue("0 0 * * 0", new Date(2026, 0, 5, 0, 0))).toBe(false);
  });

  it("day-of-month and month fields are respected together", () => {
    expect(isCronDue("0 0 1 1 *", new Date(2026, 0, 1, 0, 0))).toBe(true); // Jan 1st
    expect(isCronDue("0 0 1 1 *", new Date(2026, 1, 1, 0, 0))).toBe(false); // Feb 1st
  });

  it("throws on malformed expressions", () => {
    expect(() => isCronDue("* * * *", new Date())).toThrow();
    expect(() => validateCronExpression("* * * *")).toThrow();
  });

  it("validateCronExpression() does not throw on a well-formed 5-field expression", () => {
    expect(() => validateCronExpression("*/5 * * * *")).not.toThrow();
  });

  describe("day-of-week 7", () => {
    it("'0 0 * * 7' is Sunday, the same as 0", () => {
      // 2026-01-04 is a Sunday, 2026-01-05 a Monday.
      expect(isCronDue("0 0 * * 7", new Date(2026, 0, 4, 0, 0))).toBe(true);
      expect(isCronDue("0 0 * * 7", new Date(2026, 0, 5, 0, 0))).toBe(false);
    });

    it("a range through 7 covers Sunday", () => {
      // 5-7 = Fri, Sat, Sun.
      expect(isCronDue("0 0 * * 5-7", new Date(2026, 0, 2, 0, 0))).toBe(true); // Fri
      expect(isCronDue("0 0 * * 5-7", new Date(2026, 0, 3, 0, 0))).toBe(true); // Sat
      expect(isCronDue("0 0 * * 5-7", new Date(2026, 0, 4, 0, 0))).toBe(true); // Sun
      expect(isCronDue("0 0 * * 5-7", new Date(2026, 0, 5, 0, 0))).toBe(false); // Mon
    });

    it("normalises 7 to 0 rather than keeping it in the compiled set", () => {
      expect([...parseCronExpression("0 0 * * 7").dayOfWeek.values]).toEqual([0]);
    });
  });

  describe("day-of-month / day-of-week OR", () => {
    it("ORs the two day fields when both are restricted, like Vixie cron", () => {
      // 2026-09-01 is a Tuesday: the 1st, but not a Monday.
      expect(isCronDue("0 0 1 * 1", new Date(2026, 8, 1, 0, 0))).toBe(true);
      // 2026-09-07 is a Monday, but not the 1st.
      expect(isCronDue("0 0 1 * 1", new Date(2026, 8, 7, 0, 0))).toBe(true);
      // 2026-09-02, a Wednesday: neither.
      expect(isCronDue("0 0 1 * 1", new Date(2026, 8, 2, 0, 0))).toBe(false);
    });

    it("ANDs when only one day field is restricted", () => {
      // Only day-of-month restricted → the 1st, whatever weekday it is.
      expect(isCronDue("0 0 1 * *", new Date(2026, 8, 1, 0, 0))).toBe(true);
      expect(isCronDue("0 0 1 * *", new Date(2026, 8, 7, 0, 0))).toBe(false);
      // Only day-of-week restricted → every Monday, whatever date it is.
      expect(isCronDue("0 0 * * 1", new Date(2026, 8, 7, 0, 0))).toBe(true);
      expect(isCronDue("0 0 * * 1", new Date(2026, 8, 1, 0, 0))).toBe(false);
    });

    it("'?' counts as unrestricted, so it does not trigger the OR", () => {
      // `?` in day-of-month means "any", so this is a plain "every Monday".
      expect(isCronDue("0 0 ? * 1", new Date(2026, 8, 7, 0, 0))).toBe(true);
      expect(isCronDue("0 0 ? * 1", new Date(2026, 8, 1, 0, 0))).toBe(false);
    });

    it("ORs L with a restricted day-of-week", () => {
      // 2026-09-30 is the last day (a Wednesday); 2026-09-07 is a Monday.
      expect(isCronDue("0 0 L * 1", new Date(2026, 8, 30, 0, 0))).toBe(true);
      expect(isCronDue("0 0 L * 1", new Date(2026, 8, 7, 0, 0))).toBe(true);
      expect(isCronDue("0 0 L * 1", new Date(2026, 8, 8, 0, 0))).toBe(false);
    });
  });

  describe("names", () => {
    it("accepts three-letter weekday names", () => {
      expect(isCronDue("0 0 * * MON", new Date(2026, 0, 5, 0, 0))).toBe(true);
      expect(isCronDue("0 0 * * MON", new Date(2026, 0, 6, 0, 0))).toBe(false);
      expect(isCronDue("0 0 * * SUN", new Date(2026, 0, 4, 0, 0))).toBe(true);
    });

    it("accepts three-letter month names", () => {
      expect(isCronDue("0 0 1 JAN *", new Date(2026, 0, 1, 0, 0))).toBe(true);
      expect(isCronDue("0 0 1 FEB *", new Date(2026, 0, 1, 0, 0))).toBe(false);
      expect(isCronDue("0 0 1 DEC *", new Date(2026, 11, 1, 0, 0))).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isCronDue("0 0 * * mon", new Date(2026, 0, 5, 0, 0))).toBe(true);
      expect(isCronDue("0 0 * * Mon", new Date(2026, 0, 5, 0, 0))).toBe(true);
    });

    it("accepts named ranges and lists", () => {
      expect(isCronDue("0 0 * * MON-FRI", new Date(2026, 0, 5, 0, 0))).toBe(true); // Mon
      expect(isCronDue("0 0 * * MON-FRI", new Date(2026, 0, 10, 0, 0))).toBe(false); // Sat
      expect(isCronDue("0 0 * * SAT,SUN", new Date(2026, 0, 10, 0, 0))).toBe(true);
      expect(isCronDue("0 0 1 JAN-MAR *", new Date(2026, 2, 1, 0, 0))).toBe(true); // Mar
      expect(isCronDue("0 0 1 JAN-MAR *", new Date(2026, 3, 1, 0, 0))).toBe(false); // Apr
    });

    it("rejects names in fields that have none", () => {
      expect(() => validateCronExpression("MON * * * *")).toThrow(InvalidCronExpressionError);
    });
  });

  describe("@shorthand aliases", () => {
    it("expands the standard set", () => {
      expect(parseCronExpression("@hourly").expression).toBe("0 * * * *");
      expect(parseCronExpression("@daily").expression).toBe("0 0 * * *");
      expect(parseCronExpression("@midnight").expression).toBe("0 0 * * *");
      expect(parseCronExpression("@weekly").expression).toBe("0 0 * * 0");
      expect(parseCronExpression("@monthly").expression).toBe("0 0 1 * *");
      expect(parseCronExpression("@yearly").expression).toBe("0 0 1 1 *");
      expect(parseCronExpression("@annually").expression).toBe("0 0 1 1 *");
    });

    it("matches the same instants as the expanded form", () => {
      expect(isCronDue("@daily", new Date(2026, 0, 1, 0, 0))).toBe(true);
      expect(isCronDue("@daily", new Date(2026, 0, 1, 0, 1))).toBe(false);
      expect(isCronDue("@weekly", new Date(2026, 0, 4, 0, 0))).toBe(true); // Sunday
      expect(isCronDue("@weekly", new Date(2026, 0, 5, 0, 0))).toBe(false);
    });

    it("is case-insensitive and tolerates surrounding whitespace", () => {
      expect(parseCronExpression("  @DAILY  ").expression).toBe("0 0 * * *");
    });

    it("rejects an unknown shorthand, and @reboot specifically", () => {
      expect(() => validateCronExpression("@fortnightly")).toThrow(/unknown shorthand/);
      expect(() => validateCronExpression("@reboot")).toThrow(/@reboot/);
    });
  });

  describe("validation at parse time", () => {
    it("rejects an out-of-range minute rather than silently never firing", () => {
      expect(() => validateCronExpression("99 * * * *")).toThrow(InvalidCronExpressionError);
      expect(() => validateCronExpression("99 * * * *")).toThrow(/minute field/);
    });

    it("rejects out-of-range values in every field", () => {
      expect(() => validateCronExpression("* 24 * * *")).toThrow(/hour field/);
      expect(() => validateCronExpression("* * 32 * *")).toThrow(/day-of-month field/);
      expect(() => validateCronExpression("* * 0 * *")).toThrow(/day-of-month field/);
      expect(() => validateCronExpression("* * * 13 *")).toThrow(/month field/);
      expect(() => validateCronExpression("* * * 0 *")).toThrow(/month field/);
      expect(() => validateCronExpression("* * * * 8")).toThrow(/day-of-week field/);
    });

    it("rejects non-numeric junk, naming the field and the text", () => {
      expect(() => validateCronExpression("abc * * * *")).toThrow(/minute field: "abc"/);
    });

    it("rejects a zero or malformed step", () => {
      expect(() => validateCronExpression("*/0 * * * *")).toThrow(/invalid step/);
      expect(() => validateCronExpression("*/x * * * *")).toThrow(/invalid step/);
      expect(() => validateCronExpression("*/2/3 * * * *")).toThrow(/more than one step/);
    });

    it("rejects an inverted range", () => {
      expect(() => validateCronExpression("5-1 * * * *")).toThrow(/inverted range/);
    });

    it("rejects an empty component", () => {
      expect(() => validateCronExpression("1,,2 * * * *")).toThrow(/empty component/);
    });

    it("rejects '?' outside the day fields", () => {
      expect(() => validateCronExpression("? * * * *")).toThrow(/only valid in the day-of-month/);
    });

    it("reports the field count for the wrong number of fields", () => {
      expect(() => validateCronExpression("* * * *")).toThrow(/expected 5 fields, got 4/);
      expect(() => validateCronExpression("* * * * * *")).toThrow(/expected 5 fields, got 6/);
    });
  });

  describe("step forms", () => {
    it("'a/n' steps from a to the field's maximum", () => {
      expect(isCronDue("5/15 * * * *", new Date(2026, 0, 1, 0, 5))).toBe(true);
      expect(isCronDue("5/15 * * * *", new Date(2026, 0, 1, 0, 20))).toBe(true);
      expect(isCronDue("5/15 * * * *", new Date(2026, 0, 1, 0, 50))).toBe(true);
      expect(isCronDue("5/15 * * * *", new Date(2026, 0, 1, 0, 10))).toBe(false);
    });

    it("a step on a wildcard counts from the field's minimum, not from zero", () => {
      // Day-of-month's minimum is 1, so */2 is 1, 3, 5, … not 0, 2, 4.
      expect(isCronDue("0 0 */2 * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
      expect(isCronDue("0 0 */2 * *", new Date(2026, 0, 3, 0, 0))).toBe(true);
      expect(isCronDue("0 0 */2 * *", new Date(2026, 0, 2, 0, 0))).toBe(false);
    });
  });

  describe("nextCronRun", () => {
    it("finds the next matching minute", () => {
      const next = nextCronRun(parseCronExpression("0 0 * * *"), new Date(2026, 0, 1, 10, 0));
      expect(next).toEqual(new Date(2026, 0, 2, 0, 0));
    });

    it("is strictly in the future, even when 'from' itself matches", () => {
      const next = nextCronRun(parseCronExpression("* * * * *"), new Date(2026, 0, 1, 10, 0, 30));
      expect(next).toEqual(new Date(2026, 0, 1, 10, 1));
    });

    it("finds a once-a-year expression", () => {
      const next = nextCronRun(parseCronExpression("0 0 1 1 *"), new Date(2026, 5, 1, 0, 0));
      expect(next).toEqual(new Date(2027, 0, 1, 0, 0));
    });

    it("returns undefined for an expression that can never match", () => {
      // Day 30 of February.
      expect(nextCronRun(parseCronExpression("0 0 30 2 *"), new Date(2026, 0, 1))).toBeUndefined();
    });

    it("honours the day-of-month/day-of-week OR", () => {
      // 2026-09-02 is a Wednesday; the next 1st-or-Monday is Mon the 7th.
      const next = nextCronRun(parseCronExpression("0 0 1 * 1"), new Date(2026, 8, 2, 12, 0));
      expect(next).toEqual(new Date(2026, 8, 7, 0, 0));
    });

    it("resolves in the given timezone", () => {
      // 09:00 in New York on 2026-01-01 is 14:00 UTC.
      const next = nextCronRun(
        parseCronExpression("0 9 * * *"),
        new Date(Date.UTC(2026, 0, 1, 0, 0)),
        "America/New_York",
      );
      expect(next?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
    });

    it("does not loop or skip across a DST fall-back", () => {
      // US DST ends 2026-11-01, when 01:30 America/New_York happens twice.
      // The first occurrence is 05:30 UTC; the scan must return that one
      // and terminate rather than oscillating between the two.
      const next = nextCronRun(
        parseCronExpression("30 1 * * *"),
        new Date(Date.UTC(2026, 10, 1, 0, 0)),
        "America/New_York",
      );
      expect(next?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    });

    it("returns undefined for a wall-clock time that DST skips over", () => {
      // US DST starts 2026-03-08: 02:30 local never happens that day. The
      // scan must move on to the next day rather than stalling.
      const next = nextCronRun(
        parseCronExpression("30 2 8 3 *"),
        new Date(Date.UTC(2026, 2, 1)),
        "America/New_York",
      );
      expect(next).toBeUndefined();
    });
  });

  describe("'L' last-day-of-month token", () => {
    it("matches only the final calendar day", () => {
      // 2026-02 has 28 days.
      expect(isCronDue("0 0 L * *", new Date(2026, 1, 28, 0, 0))).toBe(true);
      expect(isCronDue("0 0 L * *", new Date(2026, 1, 27, 0, 0))).toBe(false);
      // April has 30.
      expect(isCronDue("0 0 L * *", new Date(2026, 3, 30, 0, 0))).toBe(true);
      expect(isCronDue("0 0 L * *", new Date(2026, 3, 29, 0, 0))).toBe(false);
    });

    it("accounts for leap years", () => {
      // 2028 is a leap year → Feb has 29 days.
      expect(isCronDue("0 0 L * *", new Date(2028, 1, 29, 0, 0))).toBe(true);
      expect(isCronDue("0 0 L * *", new Date(2028, 1, 28, 0, 0))).toBe(false);
    });
  });

  describe("timezone argument", () => {
    it("evaluates the wall-clock fields in the given zone", () => {
      // 2026-01-01 12:00 UTC = 07:00 America/New_York (UTC-5).
      const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0));
      expect(isCronDue("0 7 * * *", noonUtc, "America/New_York")).toBe(true);
      expect(isCronDue("0 12 * * *", noonUtc, "America/New_York")).toBe(false);
    });

    it("matches UTC hour when zone is UTC", () => {
      const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0));
      expect(isCronDue("0 12 * * *", noonUtc, "UTC")).toBe(true);
    });
  });
});
