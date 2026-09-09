/**
 * Plan §25's property-based section, done with a small deterministic
 * generator rather than a property-testing dependency.
 *
 * A seeded LCG is used instead of `Math.random` so that a failure is
 * reproducible from the printed case alone — a randomly-failing date test
 * that can't be re-run is nearly useless.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";

const ZONES = [
  "UTC",
  "Australia/Perth",
  "Australia/Sydney",
  "America/New_York",
  "Europe/London",
  "Asia/Kolkata",
  "Pacific/Chatham",
];

/** Deterministic pseudo-random source; same sequence on every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 0x1_0000_0000;
  };
}

const EPOCH_RANGE_START = Date.UTC(1970, 0, 1);
const EPOCH_RANGE_END = Date.UTC(2100, 0, 1);

function sample(count: number, seed: number): DateTime[] {
  const random = makeRandom(seed);
  const cases: DateTime[] = [];

  for (let i = 0; i < count; i++) {
    const instant = Math.floor(
      EPOCH_RANGE_START + random() * (EPOCH_RANGE_END - EPOCH_RANGE_START),
    );
    const zone = ZONES[Math.floor(random() * ZONES.length)]!;
    cases.push(DateTime.fromTimestamp(instant, zone));
  }

  return cases;
}

const CASES = sample(400, 20260820);

describe("invariants", () => {
  it("round-trips through components and back", () => {
    for (const date of CASES) {
      const { timezone, ...components } = date.toObject();
      const revived = DateTime.fromComponents(components, timezone);

      // Equality of *wall clock*, not instant: an ambiguous hour during a
      // fall-back genuinely maps back to the earlier of its two instants,
      // and no amount of component data can distinguish them.
      expect(revived.toObject()).toEqual(date.toObject());
    }
  });

  it("round-trips through ISO strings exactly, offsets included", () => {
    for (const date of CASES) {
      const revived = DateTime.parse(date.toISOString(), date.timezone);
      expect(revived.epochMilliseconds).toBe(date.epochMilliseconds);
    }
  });

  it("round-trips through JSON", () => {
    for (const date of CASES) {
      const revived = DateTime.parse(JSON.parse(JSON.stringify(date)) as string, date.timezone);
      expect(revived.epochMilliseconds).toBe(date.epochMilliseconds);
    }
  });

  it("reverses exact arithmetic exactly", () => {
    for (const date of CASES) {
      for (const amount of [1, 59, 3_600_001]) {
        expect(date.addMilliseconds(amount).subMilliseconds(amount).epochMilliseconds).toBe(
          date.epochMilliseconds,
        );
        expect(date.addHours(amount).subHours(amount).epochMilliseconds).toBe(
          date.epochMilliseconds,
        );
      }
    }
  });

  it("reverses day arithmetic on the wall clock", () => {
    for (const date of CASES) {
      const roundTripped = date.addDays(37).subDays(37);

      // The *instant* may shift if the wall clock was ambiguous or in a gap
      // at either end, but the calendar date and time-of-day must return.
      expect(roundTripped.toISODate()).toBe(date.toISODate());
      expect(roundTripped.hour).toBe(date.hour);
      expect(roundTripped.minute).toBe(date.minute);
    }
  });

  it("reverses month arithmetic except where the day-of-month was clamped", () => {
    for (const date of CASES) {
      const roundTripped = date.addMonths(5).subMonths(5);

      if (date.day <= 28) {
        expect(roundTripped.toISODate()).toBe(date.toISODate());
      } else {
        // A clamp is lossy by design; all we can require is that it never
        // moves further than the length of the shortest month.
        expect(Math.abs(roundTripped.diffInDays(date))).toBeLessThanOrEqual(3);
      }
    }
  });

  it("keeps comparison consistent and antisymmetric", () => {
    for (let i = 0; i < CASES.length - 1; i++) {
      const a = CASES[i]!;
      const b = CASES[i + 1]!;

      expect(a.compareTo(b)).toBe(-b.compareTo(a) || 0);
      expect(a.isBefore(b)).toBe(b.isAfter(a));
      expect(a.isEqual(b)).toBe(b.isEqual(a));
      expect(a.isBefore(a)).toBe(false);
      expect(a.isEqual(a)).toBe(true);
    }
  });

  it("keeps exact differences antisymmetric regardless of zone", () => {
    for (let i = 0; i < CASES.length - 1; i++) {
      const a = CASES[i]!;
      const b = CASES[i + 1]!;

      expect(a.diffInMilliseconds(b)).toBe(-b.diffInMilliseconds(a));
      expect(a.diffInHours(b, { float: true })).toBe(-b.diffInHours(a, { float: true }));
    }
  });

  it("keeps day differences antisymmetric within a shared calendar", () => {
    for (let i = 0; i < CASES.length - 1; i++) {
      const a = CASES[i]!;
      const b = CASES[i + 1]!.inTimezone(a.timezone);

      expect(a.diffInDays(b, { float: true })).toBe(-b.diffInDays(a, { float: true }));
    }
  });

  it("never overshoots when a month difference is added back", () => {
    // Month differences are *not* antisymmetric — the fraction is measured
    // against the length of the next month from the anchor, and months have
    // different lengths in each direction. What must hold is that stepping
    // by the whole-month count always lands between the two dates.
    for (let i = 0; i < CASES.length - 1; i++) {
      const a = CASES[i]!;
      const b = CASES[i + 1]!.inTimezone(a.timezone);

      const months = a.diffInMonths(b);
      const stepped = a.addMonths(months);

      expect(stepped.isBetween(a, b)).toBe(true);
      // Differences point *towards* the argument, so a positive count means
      // `b` is later, which is `compareTo === -1`.
      expect(months === 0 || Math.sign(months) === -a.compareTo(b)).toBe(true);
    }
  });

  it("measures calendar distance in the receiver's zone, so mixed zones can differ", () => {
    // Not a bug: "how many days between these" is a question about a
    // calendar, and the two objects are on different calendars. The exact
    // elapsed time is identical; only the calendar framing differs.
    const perth = DateTime.parse("2026-08-20T20:00:00Z", "Australia/Perth");
    const london = DateTime.parse("2026-08-21T10:00:00Z", "Europe/London");

    expect(perth.diffInMilliseconds(london)).toBe(-london.diffInMilliseconds(perth));
    expect(perth.diffInDays(london)).toBe(0);
    expect(london.diffInDays(perth)).toBe(0);
    expect(perth.isSameDay(london)).toBe(true);
    expect(london.isSameDay(perth)).toBe(false);
  });

  it("keeps timezone conversion instant-preserving and reversible", () => {
    for (const date of CASES) {
      for (const zone of ZONES) {
        const there = date.inTimezone(zone);
        expect(there.epochMilliseconds).toBe(date.epochMilliseconds);
        expect(there.inTimezone(date.timezone).isIdentical(date)).toBe(true);
      }
    }
  });

  it("orders boundaries correctly for every unit", () => {
    const units = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;

    for (const date of CASES) {
      for (const unit of units) {
        const start = date.startOf(unit);
        const end = date.endOf(unit);

        expect(start.isAfter(date)).toBe(false);
        expect(end.isBefore(date)).toBe(false);
        expect(start.isBefore(end)).toBe(true);
        // Truncation is idempotent.
        expect(start.startOf(unit).isEqual(start)).toBe(true);
      }
    }
  });

  it("keeps min and max consistent with pairwise comparison", () => {
    for (let i = 0; i < CASES.length - 2; i++) {
      const trio = [CASES[i]!, CASES[i + 1]!, CASES[i + 2]!];
      const min = DateTime.min(...trio);
      const max = DateTime.max(...trio);

      for (const value of trio) {
        expect(min.isAfter(value)).toBe(false);
        expect(max.isBefore(value)).toBe(false);
        expect(value.isBetween(min, max)).toBe(true);
      }
    }
  });

  it("keeps Duration round trips exact for exact durations", () => {
    for (const date of CASES) {
      const duration = Duration.hours(13).addMinutes(37).addSeconds(11);
      expect(date.add(duration).subtract(duration).epochMilliseconds).toBe(date.epochMilliseconds);
    }
  });

  it("keeps diff() and add() mutually consistent", () => {
    for (let i = 0; i < CASES.length - 1; i++) {
      const a = CASES[i]!;
      const b = CASES[i + 1]!;

      expect(a.add(a.diff(b)).epochMilliseconds).toBe(b.epochMilliseconds);
    }
  });
});
