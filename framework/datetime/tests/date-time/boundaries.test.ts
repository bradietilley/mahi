import { afterEach, describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { resetDefaultTimezone, setDefaultWeekStartsOn } from "../../src/config.js";

afterEach(() => {
  setDefaultWeekStartsOn(1);
  resetDefaultTimezone();
});

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("DateTime boundaries", () => {
  const date = utc("2026-08-20T14:30:15.250Z"); // a Thursday

  it("truncates to the start of each unit", () => {
    expect(date.startOfSecond().toISOString()).toBe("2026-08-20T14:30:15.000Z");
    expect(date.startOfMinute().toISOString()).toBe("2026-08-20T14:30:00.000Z");
    expect(date.startOfHour().toISOString()).toBe("2026-08-20T14:00:00.000Z");
    expect(date.startOfDay().toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(date.startOfMonth().toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(date.startOfQuarter().toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(date.startOfYear().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("extends to the last representable millisecond of each unit", () => {
    expect(date.endOfSecond().toISOString()).toBe("2026-08-20T14:30:15.999Z");
    expect(date.endOfMinute().toISOString()).toBe("2026-08-20T14:30:59.999Z");
    expect(date.endOfHour().toISOString()).toBe("2026-08-20T14:59:59.999Z");
    expect(date.endOfDay().toISOString()).toBe("2026-08-20T23:59:59.999Z");
    expect(date.endOfMonth().toISOString()).toBe("2026-08-31T23:59:59.999Z");
    expect(date.endOfQuarter().toISOString()).toBe("2026-09-30T23:59:59.999Z");
    expect(date.endOfYear().toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("treats startOf/endOf millisecond as identity", () => {
    expect(date.startOfMillisecond().isEqual(date)).toBe(true);
    expect(date.endOfMillisecond().isEqual(date)).toBe(true);
  });

  it("ends February on the right day in both common and leap years", () => {
    expect(utc("2026-02-10").endOfMonth().toISODate()).toBe("2026-02-28");
    expect(utc("2028-02-10").endOfMonth().toISODate()).toBe("2028-02-29");
  });

  it("puts each quarter on the right months", () => {
    expect(utc("2026-02-10").startOfQuarter().toISODate()).toBe("2026-01-01");
    expect(utc("2026-05-10").startOfQuarter().toISODate()).toBe("2026-04-01");
    expect(utc("2026-08-10").endOfQuarter().toISODate()).toBe("2026-09-30");
    expect(utc("2026-11-10").endOfQuarter().toISODate()).toBe("2026-12-31");
  });

  describe("weeks", () => {
    it("starts the week on Monday by default", () => {
      expect(date.startOfWeek().toISODate()).toBe("2026-08-17");
      expect(date.endOfWeek().toISOString()).toBe("2026-08-23T23:59:59.999Z");
    });

    it("honours an explicit week start", () => {
      expect(date.startOfWeek({ weekStartsOn: 0 }).toISODate()).toBe("2026-08-16");
      expect(date.startOfWeek({ weekStartsOn: 6 }).toISODate()).toBe("2026-08-15");
      expect(date.endOfWeek({ weekStartsOn: 0 }).toISODate()).toBe("2026-08-22");
    });

    it("honours the configured default week start", () => {
      setDefaultWeekStartsOn(0);
      expect(date.startOfWeek().toISODate()).toBe("2026-08-16");
    });

    it("returns the same day when already on the week start", () => {
      expect(utc("2026-08-17T09:00:00Z").startOfWeek().toISODate()).toBe("2026-08-17");
    });

    it("crosses a month boundary backwards", () => {
      // 1 September 2026 is a Tuesday, so its Monday is in August.
      expect(utc("2026-09-01T12:00:00Z").startOfWeek().toISODate()).toBe("2026-08-31");
    });
  });

  it("computes boundaries against the instance's own zone", () => {
    // 20:00 UTC is already the 21st in Perth, so its day boundaries differ.
    const instant = "2026-08-20T20:00:00Z";

    expect(DateTime.parse(instant, "UTC").startOfDay().toISOString()).toBe(
      "2026-08-20T00:00:00.000Z",
    );
    expect(DateTime.parse(instant, "Australia/Perth").startOfDay().toISOString()).toBe(
      "2026-08-21T00:00:00.000+08:00",
    );
  });

  it("chains into the plan §31 target expression", () => {
    DateTime.setTestNow("2026-08-20T06:30:00Z");
    try {
      expect(DateTime.now("UTC").addDays(7).endOfDay().toISOString()).toBe(
        "2026-08-27T23:59:59.999Z",
      );
    } finally {
      DateTime.setTestNow(null);
    }
  });
});
