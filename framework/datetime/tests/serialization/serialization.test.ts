import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";

describe("serialization", () => {
  const perth = DateTime.create(2026, 8, 20, 14, 30, 45, 123, "Australia/Perth");

  it("serialises through JSON.stringify without losing the local wall clock", () => {
    expect(JSON.stringify({ at: perth })).toBe('{"at":"2026-08-20T14:30:45.123+08:00"}');
  });

  it("round-trips the instant through JSON", () => {
    const revived = DateTime.parse(JSON.parse(JSON.stringify(perth)) as string, "Australia/Perth");

    expect(revived.epochMilliseconds).toBe(perth.epochMilliseconds);
    expect(revived.hour).toBe(14);
  });

  it("keeps the offset, so a naive consumer cannot silently read it as UTC", () => {
    // The classic data-loss bug is emitting "2026-08-20T14:30:45" with no
    // offset; a consumer then reads it as UTC and the instant moves.
    expect(perth.toJSON()).toContain("+08:00");
    expect(new Date(perth.toJSON()).getTime()).toBe(perth.epochMilliseconds);
  });

  it("keeps the zone name in toObject, which an ISO string cannot carry", () => {
    expect(perth.toObject()).toEqual({
      year: 2026,
      month: 8,
      day: 20,
      hour: 14,
      minute: 30,
      second: 45,
      millisecond: 123,
      timezone: "Australia/Perth",
      offset: 8 * 3_600_000,
    });
  });

  it("exposes components as an array with a 1-based month", () => {
    expect(perth.toArray()).toEqual([2026, 8, 20, 14, 30, 45, 123]);
  });

  it("converts to native interop types", () => {
    expect(perth.toDate()).toBeInstanceOf(Date);
    expect(perth.toDate().getTime()).toBe(perth.epochMilliseconds);
    expect(perth.toTimestamp()).toBe(perth.epochMilliseconds);
    expect(perth.toUnixTimestamp()).toBe(Math.floor(perth.epochMilliseconds / 1000));
  });

  it("hands out a fresh Date each time, so callers cannot mutate shared state", () => {
    const first = perth.toDate();
    first.setUTCFullYear(1999);

    expect(perth.year).toBe(2026);
    expect(perth.toDate().getUTCFullYear()).toBe(2026);
  });

  it("survives a full round trip through toObject", () => {
    const { timezone, ...components } = perth.toObject();
    const revived = DateTime.fromComponents(components, timezone);

    expect(revived.isIdentical(perth)).toBe(true);
  });

  describe("Duration", () => {
    it("serialises as an ISO 8601 duration", () => {
      expect(Duration.hours(3).toJSON()).toBe("PT3H");
      expect(JSON.stringify({ ttl: Duration.minutes(90) })).toBe('{"ttl":"PT1H30M"}');
    });

    it("keeps months as months rather than expanding them into days", () => {
      // Expanding would silently commit to a month length that depends on
      // which month you eventually apply it to.
      expect(Duration.months(1).toISOString()).toBe("P1M");
      expect(Duration.years(1).addMonths(2).toISOString()).toBe("P1Y2M");
    });
  });
});
