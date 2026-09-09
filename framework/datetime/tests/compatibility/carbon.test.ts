/**
 * Plan §27 — the executable form of the compatibility matrix.
 *
 * Two kinds of assertion live here, and the distinction is the point:
 *
 * - **Parity**: this package must produce the same answer Carbon does. The
 *   expected values were taken from Carbon's own documented behaviour, not
 *   from this implementation, so a regression that "still looks reasonable"
 *   still fails.
 * - **Deviation**: this package deliberately produces a *different* answer.
 *   Each of those is pinned too, with the reasoning, so that a deviation can
 *   never quietly become an accident.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";
import { InvalidFormatError } from "../../src/errors.js";
import { Interval } from "../../src/interval.js";
import { Period } from "../../src/period.js";

const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("Carbon parity", () => {
  describe("construction", () => {
    it("matches Carbon::now / today / yesterday / tomorrow", () => {
      DateTime.setTestNow("2026-08-20T14:30:00Z");

      expect(DateTime.now().toISOString()).toBe("2026-08-20T14:30:00.000Z");
      expect(DateTime.today().toISOString()).toBe("2026-08-20T00:00:00.000Z");
      expect(DateTime.yesterday().toISODate()).toBe("2026-08-19");
      expect(DateTime.tomorrow().toISODate()).toBe("2026-08-21");
    });

    it("matches Carbon::create with 1-based months", () => {
      // Carbon's months are 1-based; JavaScript's `Date` is not, and that
      // off-by-one is the single most common date bug in the language.
      expect(DateTime.create(2026, 8, 20, 14, 30).toISOString()).toBe("2026-08-20T14:30:00.000Z");
    });

    it("matches Carbon::createFromTimestamp", () => {
      expect(DateTime.fromUnixTimestamp(1_787_236_200).toISOString()).toBe(
        "2026-08-20T14:30:00.000Z",
      );
    });
  });

  describe("accessors", () => {
    const date = utc("2026-08-20T14:30:45.123Z");

    it("matches Carbon's component accessors", () => {
      expect(date.year).toBe(2026);
      expect(date.month).toBe(8);
      expect(date.day).toBe(20);
      expect(date.hour).toBe(14);
      expect(date.minute).toBe(30);
      expect(date.second).toBe(45);
      expect(date.millisecond).toBe(123);
      expect(date.dayOfWeek).toBe(4);
      expect(date.dayOfYear).toBe(232);
      expect(date.quarter).toBe(3);
      expect(date.daysInMonth).toBe(31);
      expect(date.weekOfMonth).toBe(3);
      expect(date.century).toBe(21);
    });
  });

  describe("mutation", () => {
    it("matches Carbon's add/sub family", () => {
      const date = utc("2026-08-20T14:30:00Z");

      expect(date.addDays(5).toISODate()).toBe("2026-08-25");
      expect(date.subWeeks(2).toISODate()).toBe("2026-08-06");
      expect(date.addQuarters(1).toISODate()).toBe("2026-11-20");
      expect(date.addHours(12).toISOString()).toBe("2026-08-21T02:30:00.000Z");
    });

    it("matches Carbon's addMonthsNoOverflow, which is this package's default", () => {
      // Carbon: (new Carbon('2026-01-31'))->addMonthNoOverflow() === 2026-02-28
      expect(utc("2026-01-31T00:00:00Z").addMonths(1).toISODate()).toBe("2026-02-28");
    });

    it("matches Carbon's overflowing addMonths under its explicit name", () => {
      // Carbon: (new Carbon('2026-01-31'))->addMonth() === 2026-03-03
      expect(utc("2026-01-31T00:00:00Z").addMonthsWithOverflow(1).toISODate()).toBe("2026-03-03");
    });

    it("matches Carbon's boundary helpers", () => {
      const date = utc("2026-08-20T14:30:45.123Z");

      expect(date.startOfDay().toISOString()).toBe("2026-08-20T00:00:00.000Z");
      expect(date.endOfDay().toISOString()).toBe("2026-08-20T23:59:59.999Z");
      expect(date.startOfMonth().toISODate()).toBe("2026-08-01");
      expect(date.endOfMonth().toISODate()).toBe("2026-08-31");
      expect(date.startOfQuarter().toISODate()).toBe("2026-07-01");
      expect(date.endOfYear().toISODate()).toBe("2026-12-31");
      expect(date.startOfDecade().toISODate()).toBe("2020-01-01");
      // Carbon's centuries are ordinal: 2001–2100.
      expect(date.startOfCentury().toISODate()).toBe("2001-01-01");
    });
  });

  describe("comparison", () => {
    it("matches Carbon's predicate family", () => {
      DateTime.setTestNow("2026-08-20T12:00:00Z");

      expect(utc("2026-08-22T12:00:00Z").isWeekend()).toBe(true);
      expect(utc("2026-08-20T12:00:00Z").isWeekday()).toBe(true);
      expect(utc("2026-08-20T12:00:00Z").isThursday()).toBe(true);
      expect(utc("2024-01-01T00:00:00Z").isLeapYear()).toBe(true);
      expect(utc("2026-08-19T12:00:00Z").isPast()).toBe(true);
      expect(utc("2026-08-21T12:00:00Z").isFuture()).toBe(true);
      expect(utc("2026-08-20T18:00:00Z").isToday()).toBe(true);
      expect(utc("2026-08-31T00:00:00Z").isLastDayOfMonth()).toBe(true);
    });
  });

  describe("differences", () => {
    it("matches Carbon's diffIn* truncation toward zero", () => {
      const from = utc("2026-08-20T00:00:00Z");

      expect(from.diffInDays("2026-08-25T23:00:00Z")).toBe(5);
      expect(from.diffInHours("2026-08-20T23:59:00Z")).toBe(23);
      expect(from.diffInMonths("2027-01-19T00:00:00Z")).toBe(4);
      expect(from.diffInYears("2028-08-19T00:00:00Z")).toBe(1);
    });

    it("matches Carbon's signed and absolute variants", () => {
      const from = utc("2026-08-20T00:00:00Z");

      expect(from.diffInDays("2026-08-15T00:00:00Z")).toBe(-5);
      expect(from.diffInDays("2026-08-15T00:00:00Z", { absolute: true })).toBe(5);
    });
  });

  describe("relative time", () => {
    it("produces Carbon's canonical phrases in English", () => {
      DateTime.setTestNow("2026-08-20T12:00:00Z");

      expect(utc("2026-08-20T11:55:00Z").diffForHumans()).toBe("5 minutes ago");
      expect(utc("2026-08-17T12:00:00Z").diffForHumans()).toBe("3 days ago");
      expect(utc("2026-08-20T14:00:00Z").diffForHumans()).toBe("in 2 hours");
    });
  });

  describe("intervals and periods", () => {
    it("covers CarbonInterval's role with Duration", () => {
      const duration = Duration.days(2).addHours(4).addMinutes(30);

      expect(duration.totalHours).toBe(52.5);
      expect(duration.toISOString()).toBe("P2DT4H30M");
    });

    it("covers CarbonPeriod's role with Period", () => {
      const period = Period.days(utc("2026-08-01T00:00:00Z"), utc("2026-08-05T00:00:00Z"));

      // CarbonPeriod includes both ends, and so does this.
      expect(period.count()).toBe(5);
      expect(period.first()?.toISODate()).toBe("2026-08-01");
      expect(period.last()?.toISODate()).toBe("2026-08-05");
    });

    it("adds a span type Carbon does not have", () => {
      // Carbon has no first-class interval; `Interval` fills the gap with
      // half-open semantics that Carbon never had to choose.
      const interval = Interval.between(utc("2026-08-01T09:00:00Z"), utc("2026-08-01T10:00:00Z"));
      expect(interval.contains(utc("2026-08-01T10:00:00Z"))).toBe(false);
    });
  });

  describe("business days", () => {
    it("matches Carbon's weekday stepping", () => {
      expect(utc("2026-08-21T00:00:00Z").addBusinessDays(1).toISODate()).toBe("2026-08-24");
      expect(utc("2026-08-24T00:00:00Z").subBusinessDays(1).toISODate()).toBe("2026-08-21");
    });
  });

  describe("serialization", () => {
    it("survives JSON.stringify with its offset intact", () => {
      const perth = DateTime.parse("2026-08-20T14:30:00", "Australia/Perth");

      expect(JSON.stringify({ at: perth })).toBe('{"at":"2026-08-20T14:30:00.000+08:00"}');
      expect(DateTime.parse(JSON.parse(JSON.stringify(perth)) as string).isEqual(perth)).toBe(true);
    });
  });
});

describe("Deliberate deviations from Carbon", () => {
  it("uses Unicode format tokens, not PHP date() tokens", () => {
    // Carbon: ->format('Y-m-d'). Here that pattern means something else
    // entirely, so the confusable subset is rejected rather than guessed at.
    expect(utc("2026-08-20T14:30:00Z").format("yyyy-MM-dd")).toBe("2026-08-20");
    expect(() => utc("2026-08-20T14:30:00Z").format("YYYY-MM-DD")).toThrow(InvalidFormatError);
  });

  it("has no invalid-instance state", () => {
    // Carbon and native `Date` both let a poisoned object propagate. Here the
    // constructor is the only place a failure can occur.
    expect(() => DateTime.parse("2026-02-30")).toThrow();
    expect(DateTime.parseSafe("2026-02-30")).toBeNull();
  });

  it("refuses to guess ambiguous date layouts", () => {
    // Carbon would read this as a date under the active locale's convention.
    expect(() => DateTime.parse("03/04/2026")).toThrow();
    expect(DateTime.createFromFormat("03/04/2026", "dd/MM/yyyy", "UTC").toISODate()).toBe(
      "2026-04-03",
    );
  });

  it("answers calendar comparisons in the receiver's zone", () => {
    // Consequence: `isSameDay` is not symmetric across zones. Carbon has the
    // same property but does not document it; here it is a test.
    const instant = "2026-08-20T20:00:00Z";
    const london = DateTime.parse(instant, "Europe/London");
    const perth = DateTime.parse(instant, "Australia/Perth");
    const noon = DateTime.parse("2026-08-20T10:00:00Z", "UTC");

    expect(london.isSameDay(noon)).toBe(true);
    expect(perth.isSameDay(noon)).toBe(false);
  });

  it("does not claim month differences are antisymmetric", () => {
    const a = utc("2026-01-31T00:00:00Z");
    const b = utc("2026-03-31T00:00:00Z");

    // What *does* hold: stepping by the whole-month count never overshoots.
    expect(a.addMonths(a.diffInMonths(b)).isAfter(b)).toBe(false);
    expect(b.addMonths(b.diffInMonths(a)).isBefore(a)).toBe(false);
  });

  it("separates converting a zone from moving a wall clock", () => {
    // Carbon's `setTimezone()` is only the first of these. Conflating them is
    // the classic timezone bug, so they have different names here.
    const perth = DateTime.parse("2026-08-20T09:00:00", "Australia/Perth");

    expect(perth.inTimezone("Australia/Sydney").hour).toBe(11);
    expect(perth.inTimezone("Australia/Sydney").isEqual(perth)).toBe(true);

    expect(perth.keepLocalTime("Australia/Sydney").hour).toBe(9);
    expect(perth.keepLocalTime("Australia/Sydney").isEqual(perth)).toBe(false);
  });

  it("phrases two-date relative time as 'ago', not 'before'", () => {
    // Carbon: "3 days before". `Intl` exposes only now-relative frames, and
    // half-translating the rest would be worse than being explicit.
    expect(utc("2026-08-17T00:00:00Z").diffForHumans("2026-08-20T00:00:00Z")).toBe("3 days ago");
    expect(
      utc("2026-08-17T00:00:00Z").diffForHumans("2026-08-20T00:00:00Z", { syntax: "plain" }),
    ).toBe("3 days");
  });

  it("makes calendar and exact arithmetic disagree across DST, on purpose", () => {
    const before = DateTime.parse("2026-03-08T00:00:00", "America/New_York");

    // Same start, two different questions, two different answers.
    expect(before.addDays(1).format("yyyy-MM-dd HH:mm")).toBe("2026-03-09 00:00");
    expect(before.addHours(24).format("yyyy-MM-dd HH:mm")).toBe("2026-03-09 01:00");
  });
});
