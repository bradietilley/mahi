/**
 * Plan §19, with particular attention to the boundary semantics: an interval
 * is `[start, end)`, and the tests below are the record of that decision.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";
import { Interval } from "../../src/interval.js";

const at = (iso: string) => DateTime.parse(iso, "UTC");
const span = (start: string, end: string) => Interval.between(at(start), at(end));

const MORNING = span("2026-08-20T09:00:00Z", "2026-08-20T12:00:00Z");

describe("Interval construction", () => {
  it("rejects an end before its start", () => {
    expect(() => span("2026-08-20T12:00:00Z", "2026-08-20T09:00:00Z")).toThrow(
      /cannot end before it starts/,
    );
  });

  it("accepts unordered bounds via around()", () => {
    const interval = Interval.around(at("2026-08-20T12:00:00Z"), at("2026-08-20T09:00:00Z"));
    expect(interval.equals(MORNING)).toBe(true);
  });

  it("builds from a duration in either direction", () => {
    const forward = Interval.fromDuration(at("2026-08-20T09:00:00Z"), Duration.hours(3));
    const backward = Interval.endingAt(at("2026-08-20T12:00:00Z"), Duration.hours(3));

    expect(forward.equals(MORNING)).toBe(true);
    expect(backward.equals(MORNING)).toBe(true);
  });

  it("stores a closed interval as a half-open one, one millisecond longer", () => {
    const closed = Interval.closed(at("2026-08-20T09:00:00Z"), at("2026-08-20T12:00:00Z"));

    expect(closed.contains(at("2026-08-20T12:00:00Z"))).toBe(true);
    expect(closed.endInclusive.toISOString()).toBe("2026-08-20T12:00:00.000Z");
    expect(closed.lengthMs).toBe(MORNING.lengthMs + 1);
  });

  it("adopts the start's zone for both bounds", () => {
    const interval = Interval.between(
      DateTime.parse("2026-08-20T09:00:00Z", "Australia/Perth"),
      DateTime.parse("2026-08-20T12:00:00Z", "UTC"),
    );

    expect(interval.timezone).toBe("Australia/Perth");
    expect(interval.end.timezone).toBe("Australia/Perth");
  });

  it("round-trips through ISO notation", () => {
    expect(Interval.fromISOString(MORNING.toISOString()).equals(MORNING)).toBe(true);
    expect(() => Interval.fromISOString("nonsense")).toThrow(/ISO 8601 interval/);
  });
});

describe("Interval boundaries", () => {
  it("includes the start and excludes the end", () => {
    expect(MORNING.contains(at("2026-08-20T09:00:00Z"))).toBe(true);
    expect(MORNING.contains(at("2026-08-20T11:59:59.999Z"))).toBe(true);
    expect(MORNING.contains(at("2026-08-20T12:00:00Z"))).toBe(false);
    expect(MORNING.contains(at("2026-08-20T08:59:59.999Z"))).toBe(false);
  });

  it("treats an empty interval as containing nothing, not even its own instant", () => {
    const empty = Interval.empty(at("2026-08-20T09:00:00Z"));

    expect(empty.isEmpty).toBe(true);
    expect(empty.contains(at("2026-08-20T09:00:00Z"))).toBe(false);
    expect(empty.lengthMs).toBe(0);
    expect(() => empty.endInclusive).toThrow(/empty interval/);
  });

  it("measures length exactly, with no off-by-one correction", () => {
    expect(MORNING.duration.totalHours).toBe(3);
  });
});

describe("Interval relationships", () => {
  const afternoon = span("2026-08-20T12:00:00Z", "2026-08-20T15:00:00Z");
  const overlapping = span("2026-08-20T11:00:00Z", "2026-08-20T13:00:00Z");
  const evening = span("2026-08-20T18:00:00Z", "2026-08-20T20:00:00Z");

  it("does not treat touching intervals as overlapping", () => {
    // This is the whole point of half-open bounds: back-to-back bookings
    // must not be reported as a clash.
    expect(MORNING.overlaps(afternoon)).toBe(false);
    expect(MORNING.isAdjacent(afternoon)).toBe(true);
    expect(afternoon.isAdjacent(MORNING)).toBe(true);
  });

  it("detects genuine overlap", () => {
    expect(MORNING.overlaps(overlapping)).toBe(true);
    expect(overlapping.overlaps(MORNING)).toBe(true);
  });

  it("orders disjoint intervals", () => {
    expect(MORNING.isBefore(afternoon)).toBe(true);
    expect(afternoon.isAfter(MORNING)).toBe(true);
    expect(MORNING.isBefore(overlapping)).toBe(false);
  });

  it("recognises enclosure", () => {
    const inner = span("2026-08-20T10:00:00Z", "2026-08-20T11:00:00Z");

    expect(MORNING.encloses(inner)).toBe(true);
    expect(inner.encloses(MORNING)).toBe(false);
    expect(MORNING.encloses(MORNING)).toBe(true);
  });

  it("reports the gap between disjoint intervals, in either order", () => {
    expect(MORNING.gap(evening)?.toISOString()).toBe(
      "2026-08-20T12:00:00.000Z/2026-08-20T18:00:00.000Z",
    );
    expect(evening.gap(MORNING)?.toISOString()).toBe(
      "2026-08-20T12:00:00.000Z/2026-08-20T18:00:00.000Z",
    );
    expect(MORNING.gap(afternoon)).toBeNull();
    expect(MORNING.gap(overlapping)).toBeNull();
  });
});

describe("Interval set algebra", () => {
  const overlapping = span("2026-08-20T11:00:00Z", "2026-08-20T13:00:00Z");
  const afternoon = span("2026-08-20T12:00:00Z", "2026-08-20T15:00:00Z");
  const evening = span("2026-08-20T18:00:00Z", "2026-08-20T20:00:00Z");

  it("intersects only where both cover", () => {
    expect(MORNING.intersection(overlapping)?.toISOString()).toBe(
      "2026-08-20T11:00:00.000Z/2026-08-20T12:00:00.000Z",
    );
    expect(MORNING.intersection(evening)).toBeNull();
    // Touching, so nothing is shared.
    expect(MORNING.intersection(afternoon)).toBeNull();
  });

  it("unites overlapping and adjacent intervals but refuses to bridge a gap", () => {
    expect(MORNING.union(overlapping)?.toISOString()).toBe(
      "2026-08-20T09:00:00.000Z/2026-08-20T13:00:00.000Z",
    );
    expect(MORNING.union(afternoon)?.toISOString()).toBe(
      "2026-08-20T09:00:00.000Z/2026-08-20T15:00:00.000Z",
    );
    // Claiming the six hours in between would be a fabrication.
    expect(MORNING.union(evening)).toBeNull();
  });

  it("splits into two pieces when a hole is punched in the middle", () => {
    const lunch = span("2026-08-20T10:00:00Z", "2026-08-20T11:00:00Z");
    const pieces = MORNING.difference(lunch);

    expect(pieces.map((piece) => piece.toISOString())).toEqual([
      "2026-08-20T09:00:00.000Z/2026-08-20T10:00:00.000Z",
      "2026-08-20T11:00:00.000Z/2026-08-20T12:00:00.000Z",
    ]);
  });

  it("returns one piece or none for edge and total removals", () => {
    expect(MORNING.difference(overlapping).map((piece) => piece.toISOString())).toEqual([
      "2026-08-20T09:00:00.000Z/2026-08-20T11:00:00.000Z",
    ]);
    expect(MORNING.difference(MORNING)).toEqual([]);
    expect(MORNING.difference(evening).map((piece) => piece.toISOString())).toEqual([
      MORNING.toISOString(),
    ]);
  });
});

describe("Interval derivation", () => {
  it("shifts without changing length", () => {
    const shifted = MORNING.shift(Duration.hours(2));

    expect(shifted.toISOString()).toBe("2026-08-20T11:00:00.000Z/2026-08-20T14:00:00.000Z");
    expect(shifted.lengthMs).toBe(MORNING.lengthMs);
  });

  it("expands and contracts at both ends", () => {
    expect(MORNING.expand(Duration.hours(1)).toISOString()).toBe(
      "2026-08-20T08:00:00.000Z/2026-08-20T13:00:00.000Z",
    );
    expect(MORNING.expand(Duration.hours(-1)).toISOString()).toBe(
      "2026-08-20T10:00:00.000Z/2026-08-20T11:00:00.000Z",
    );
    // Contracting past zero is a negative-length interval, which is refused.
    expect(() => MORNING.expand(Duration.hours(-2))).toThrow(/cannot end before it starts/);
  });

  it("splits at interior instants and tiles the original exactly", () => {
    const pieces = MORNING.splitAt(at("2026-08-20T10:00:00Z"), at("2026-08-20T11:00:00Z"));

    expect(pieces.map((piece) => piece.toISOString())).toEqual([
      "2026-08-20T09:00:00.000Z/2026-08-20T10:00:00.000Z",
      "2026-08-20T10:00:00.000Z/2026-08-20T11:00:00.000Z",
      "2026-08-20T11:00:00.000Z/2026-08-20T12:00:00.000Z",
    ]);
    expect(pieces.reduce((total, piece) => total + piece.lengthMs, 0)).toBe(MORNING.lengthMs);
  });

  it("ignores cuts outside the interval and at its start", () => {
    const pieces = MORNING.splitAt(
      at("2026-08-20T09:00:00Z"),
      at("2026-08-20T08:00:00Z"),
      at("2026-08-20T20:00:00Z"),
    );

    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.equals(MORNING)).toBe(true);
  });
});

describe("Interval immutability", () => {
  it("never mutates the receiver", () => {
    const original = MORNING;
    const before = original.toISOString();

    original.shift(Duration.hours(5));
    original.expand(Duration.hours(1));
    original.withStart(at("2026-08-20T10:00:00Z"));

    expect(original.toISOString()).toBe(before);
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe("Interval across a DST transition", () => {
  it("measures real elapsed time, not wall-clock hours", () => {
    // US spring forward: 2026-03-08 02:00 local does not exist, so midnight
    // to midnight is 23 real hours.
    const interval = Interval.between(
      DateTime.parse("2026-03-08T00:00:00", "America/New_York"),
      DateTime.parse("2026-03-09T00:00:00", "America/New_York"),
    );

    expect(interval.duration.totalHours).toBe(23);
  });
});
