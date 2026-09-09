/**
 * Plan §26. Runs the same handful of behaviours across a spread of zones —
 * northern and southern DST, half-hour and three-quarter-hour offsets, both
 * signs, and a couple with no DST at all — so a regression in one zone family
 * can't hide behind another.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Timezone } from "../../src/timezone.js";
import { InvalidTimezoneError } from "../../src/errors.js";

const ZONES = [
  "UTC",
  "Australia/Perth",
  "Australia/Sydney",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Pacific/Chatham",
] as const;

describe("timezone matrix", () => {
  describe.each(ZONES)("%s", (zone) => {
    it("round-trips a wall clock through resolution and display", () => {
      // Deliberately mid-year and mid-afternoon, well away from any
      // transition, so this holds for every zone.
      const date = DateTime.create(2026, 6, 15, 14, 30, 0, 0, zone);

      expect(date.year).toBe(2026);
      expect(date.month).toBe(6);
      expect(date.day).toBe(15);
      expect(date.hour).toBe(14);
      expect(date.minute).toBe(30);
      expect(date.timezone).toBe(zone);
    });

    it("agrees with the offset it reports", () => {
      // The relation the whole package rests on: local wall clock minus UTC
      // wall clock is exactly the reported offset.
      const date = DateTime.create(2026, 6, 15, 14, 30, 0, 0, zone);
      const asUtc = date.utc();
      const civilOf = (d: DateTime) =>
        Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second, d.millisecond);

      expect(civilOf(date) - civilOf(asUtc)).toBe(date.offset);
    });

    it("preserves the instant when only the display zone changes", () => {
      const date = DateTime.create(2026, 6, 15, 14, 30, 0, 0, zone);

      for (const other of ZONES) {
        const converted = date.inTimezone(other);
        expect(converted.epochMilliseconds).toBe(date.epochMilliseconds);
        expect(converted.isEqual(date)).toBe(true);
      }
    });

    it("changes the instant when the wall clock is preserved instead", () => {
      const date = DateTime.create(2026, 6, 15, 14, 30, 0, 0, zone);

      for (const other of ZONES) {
        const moved = date.keepLocalTime(other);
        expect(moved.hour).toBe(14);
        expect(moved.minute).toBe(30);
        expect(moved.toISODate()).toBe("2026-06-15");
        expect(moved.isEqual(date)).toBe(other === zone);
      }
    });

    it("adds a day without drifting the wall clock", () => {
      const date = DateTime.create(2026, 6, 15, 14, 30, 0, 0, zone);
      const next = date.addDays(1);

      expect(next.hour).toBe(14);
      expect(next.minute).toBe(30);
      expect(next.day).toBe(16);
    });

    it("formats and re-parses to the same instant", () => {
      const date = DateTime.create(2026, 6, 15, 14, 30, 45, 123, zone);

      expect(DateTime.parse(date.toISOString(), zone).epochMilliseconds).toBe(
        date.epochMilliseconds,
      );
    });
  });

  it("keeps offsets that are not whole hours", () => {
    expect(DateTime.create(2026, 6, 15, 0, 0, 0, 0, "Asia/Kolkata").offsetMinutes).toBe(330);
    // Chatham Islands run at +12:45 in standard time and +13:45 on DST.
    expect(DateTime.create(2026, 6, 15, 0, 0, 0, 0, "Pacific/Chatham").offsetMinutes).toBe(765);
    expect(DateTime.create(2026, 1, 15, 0, 0, 0, 0, "Pacific/Chatham").offsetMinutes).toBe(825);
  });

  it("keeps offsets on both sides of Greenwich", () => {
    expect(DateTime.create(2026, 6, 15, 0, 0, 0, 0, "America/Los_Angeles").offsetHours).toBe(-7);
    expect(DateTime.create(2026, 6, 15, 0, 0, 0, 0, "Australia/Sydney").offsetHours).toBe(10);
    expect(DateTime.create(2026, 6, 15, 0, 0, 0, 0, "UTC").offsetHours).toBe(0);
  });

  it("crosses the date line correctly", () => {
    const instant = DateTime.parse("2026-06-15T12:00:00Z", "UTC");

    expect(instant.inTimezone("Pacific/Auckland").toISODate()).toBe("2026-06-16");
    expect(instant.inTimezone("America/Los_Angeles").toISODate()).toBe("2026-06-15");
    expect(instant.inTimezone("Pacific/Auckland").hour).toBe(0);
  });

  describe("Timezone helpers", () => {
    it("validates identifiers against the host's database", () => {
      expect(Timezone.isValid("Australia/Perth")).toBe(true);
      expect(Timezone.isValid("UTC")).toBe(true);
      expect(Timezone.isValid("Middle/Earth")).toBe(false);
      expect(() => Timezone.assertValid("Middle/Earth")).toThrow(InvalidTimezoneError);
    });

    it("reports offsets at a given instant", () => {
      const winter = Date.UTC(2026, 0, 15, 12);
      const summer = Date.UTC(2026, 6, 15, 12);

      expect(Timezone.offsetMinutesAt("America/New_York", winter)).toBe(-300);
      expect(Timezone.offsetMinutesAt("America/New_York", summer)).toBe(-240);
      expect(Timezone.offsetMinutesAt("Australia/Perth", summer)).toBe(480);
    });

    it("reports which zones observe daylight saving", () => {
      expect(Timezone.observesDST("America/New_York", 2026)).toBe(true);
      expect(Timezone.observesDST("Australia/Sydney", 2026)).toBe(true);
      expect(Timezone.observesDST("Australia/Perth", 2026)).toBe(false);
      expect(Timezone.observesDST("Asia/Tokyo", 2026)).toBe(false);
      expect(Timezone.observesDST("UTC", 2026)).toBe(false);
    });

    it("names the host's own zone", () => {
      expect(Timezone.isValid(Timezone.system())).toBe(true);
    });
  });

  it("rejects a blank zone instead of falling back to the host's", () => {
    // `Intl` treats "" as "unspecified" and substitutes the host's zone,
    // which would silently return Perth time on a Perth laptop and UTC
    // in CI.
    expect(() => DateTime.now("")).toThrow(InvalidTimezoneError);
    expect(() => DateTime.now("   ")).toThrow(InvalidTimezoneError);
    expect(Timezone.isValid("")).toBe(false);
  });

  it("rejects an unknown zone at every entry point", () => {
    expect(() => DateTime.now("Nowhere/Special")).toThrow(InvalidTimezoneError);
    expect(() => DateTime.parse("2026-06-15", "Nowhere/Special")).toThrow(InvalidTimezoneError);
    expect(() => DateTime.parse("2026-06-15", "UTC").inTimezone("Nowhere/Special")).toThrow(
      InvalidTimezoneError,
    );
  });
});
