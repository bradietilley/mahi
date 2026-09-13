/**
 * Plan §15. These assertions pin the *shape* of the output rather than every
 * translated string. The strings come from the host's CLDR data, and
 * asserting them exhaustively would turn an ICU upgrade into a failing build
 * for no benefit. The English forms are stable enough to assert directly; the
 * other locales are checked structurally.
 */

import { describe, expect, it } from "vitest";

import { setDefaultLocale } from "../../src/config.js";
import { DateTime } from "../../src/date-time.js";

const NOW = "2026-08-20T12:00:00Z";
const utc = (iso: string) => DateTime.parse(iso, "UTC");

describe("diffForHumans", () => {
  describe("relative to now", () => {
    it("phrases the past and the future", () => {
      DateTime.setTestNow(NOW);

      expect(utc("2026-08-17T12:00:00Z").diffForHumans()).toBe("3 days ago");
      expect(utc("2026-08-23T12:00:00Z").diffForHumans()).toBe("in 3 days");
      expect(utc("2026-08-20T10:00:00Z").diffForHumans()).toBe("2 hours ago");
      expect(utc("2026-08-20T12:00:30Z").diffForHumans()).toBe("in 30 seconds");
    });

    it("collapses sub-second differences to the locale's 'now'", () => {
      DateTime.setTestNow(NOW);

      expect(utc("2026-08-20T12:00:00Z").diffForHumans()).toBe("now");
      expect(utc("2026-08-20T11:59:59.500Z").diffForHumans()).toBe("now");
    });

    it("can be told not to collapse to 'now'", () => {
      DateTime.setTestNow(NOW);

      expect(utc(NOW).diffForHumans(undefined, { justNow: false })).toBe("in 0 seconds");
    });

    it("truncates rather than rounding", () => {
      DateTime.setTestNow(NOW);

      // 47 hours is one day and change, not two days.
      expect(utc("2026-08-18T13:00:00Z").diffForHumans()).toBe("1 day ago");
    });
  });

  it("uses the largest unit that fits", () => {
    DateTime.setTestNow(NOW);

    expect(utc("2025-08-20T12:00:00Z").diffForHumans()).toBe("1 year ago");
    expect(utc("2026-06-20T12:00:00Z").diffForHumans()).toBe("2 months ago");
    expect(utc("2026-08-06T12:00:00Z").diffForHumans()).toBe("2 weeks ago");
    expect(utc("2026-08-18T12:00:00Z").diffForHumans()).toBe("2 days ago");
    expect(utc("2026-08-20T11:00:00Z").diffForHumans()).toBe("1 hour ago");
    expect(utc("2026-08-20T11:45:00Z").diffForHumans()).toBe("15 minutes ago");
  });

  it("measures months on the calendar, matching addMonths", () => {
    // 31 Jan + 1 month clamps to 28 Feb, so the reverse must read as exactly
    // one month or the two APIs would contradict each other.
    expect(utc("2026-01-31T00:00:00Z").diffForHumans("2026-02-28T00:00:00Z")).toBe("1 month ago");
  });

  describe("multi-part output", () => {
    it("joins units and keeps a single frame", () => {
      DateTime.setTestNow(NOW);

      expect(utc("2026-08-18T10:30:00Z").diffForHumans(undefined, { parts: 2 })).toBe(
        "2 days, 1 hour ago",
      );
      expect(utc("2026-08-18T10:30:00Z").diffForHumans(undefined, { parts: 3 })).toBe(
        "2 days, 1 hour, 30 minutes ago",
      );
    });

    it("stops early when there is nothing left to say", () => {
      DateTime.setTestNow(NOW);

      // Exactly two days: asking for three parts must not pad with zeroes.
      expect(utc("2026-08-18T12:00:00Z").diffForHumans(undefined, { parts: 3 })).toBe("2 days ago");
    });

    it("keeps interior zeroes so the sequence stays contiguous", () => {
      DateTime.setTestNow(NOW);

      // 2 days and 30 minutes: dropping the zero hours would misread as
      // "2 days 30 minutes" being adjacent units.
      expect(utc("2026-08-18T11:30:00Z").diffForHumans(undefined, { parts: 3 })).toBe(
        "2 days, 0 hours, 30 minutes ago",
      );
    });
  });

  describe("options", () => {
    it("renders bare magnitudes under the plain syntax", () => {
      DateTime.setTestNow(NOW);

      expect(utc("2026-08-17T12:00:00Z").diffForHumans(undefined, { syntax: "plain" })).toBe(
        "3 days",
      );
      expect(utc("2026-08-23T12:00:00Z").diffForHumans(undefined, { syntax: "plain" })).toBe(
        "3 days",
      );
      expect(
        utc("2026-08-18T10:30:00Z").diffForHumans(undefined, { syntax: "plain", parts: 2 }),
      ).toBe("2 days, 1 hour");
    });

    it("abbreviates when asked", () => {
      DateTime.setTestNow(NOW);

      expect(utc("2026-08-17T12:00:00Z").diffForHumans(undefined, { short: true })).toBe("3d ago");
    });

    it("honours minimumUnit and maximumUnit", () => {
      DateTime.setTestNow(NOW);

      // Capped at days, a year-plus difference does not become "1 year".
      expect(utc("2025-07-17T12:00:00Z").diffForHumans(undefined, { maximumUnit: "day" })).toBe(
        "399 days ago",
      );

      // Anything under an hour is beneath notice, and the "nothing to report"
      // phrase is itself granularity-aware: "this hour", not "now".
      expect(utc("2026-08-20T11:30:00Z").diffForHumans(undefined, { minimumUnit: "hour" })).toBe(
        "this hour",
      );
    });

    it("tolerates a transposed unit range", () => {
      DateTime.setTestNow(NOW);

      expect(
        utc("2026-08-17T12:00:00Z").diffForHumans(undefined, {
          maximumUnit: "second",
          minimumUnit: "year",
        }),
      ).toBe("3 days ago");
    });
  });

  describe("localization", () => {
    it("takes phrasing from Intl, per call", () => {
      DateTime.setTestNow(NOW);
      const date = utc("2026-08-17T12:00:00Z");

      expect(date.diffForHumans(undefined, { locale: "fr" })).toBe("il y a 3 jours");
      expect(date.diffForHumans(undefined, { locale: "es" })).toBe("hace 3 días");
    });

    it("derives the multi-part frame in non-English locales", () => {
      DateTime.setTestNow(NOW);

      // The frame ("il y a …") is recovered from Intl at runtime rather than
      // from a shipped translation table. Spaces are normalised for the
      // assertion because `Intl.NumberFormat` separates a French quantity
      // from its unit with U+00A0.
      const french = utc("2026-08-18T10:30:00Z")
        .diffForHumans(undefined, { locale: "fr", parts: 2 })
        .replace(/\s/gu, " ");

      expect(french).toBe("il y a 2 jours et 1 heure");
    });

    it("falls back to the configured locale", () => {
      DateTime.setTestNow(NOW);
      setDefaultLocale("fr");

      expect(utc("2026-08-17T12:00:00Z").diffForHumans()).toBe("il y a 3 jours");
    });
  });

  describe("direction helpers", () => {
    it("inverts consistently", () => {
      DateTime.setTestNow(NOW);
      const past = utc("2026-08-17T12:00:00Z");

      expect(past.fromNow()).toBe("3 days ago");
      expect(past.toNow()).toBe("in 3 days");

      const other = utc("2026-08-23T12:00:00Z");
      expect(past.from(other)).toBe("6 days ago");
      expect(past.to(other)).toBe("in 6 days");
    });

    it("compares instants across zones without double-counting the offset", () => {
      const perth = DateTime.parse("2026-08-20T20:00:00+08:00", "Australia/Perth");
      const london = DateTime.parse("2026-08-20T12:00:00Z", "Europe/London");

      // Same instant, different clocks.
      expect(perth.diffForHumans(london)).toBe("now");
    });
  });
});
