/**
 * Plan §20. The assertions that matter most here are anchored stepping
 * (monthly sequences must not drift to the 28th and stay there) and the
 * inclusive-end convention, which is deliberately the opposite of
 * `Interval`'s.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { Duration } from "../../src/duration.js";
import { Interval } from "../../src/interval.js";
import { Period } from "../../src/period.js";

const at = (iso: string) => DateTime.parse(iso, "UTC");
const dates = (period: Period) => period.map((date) => date.toISODate());

describe("Period iteration", () => {
  it("includes both bounds by default", () => {
    expect(dates(Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-04T00:00:00Z")))).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
  });

  it("can exclude either bound", () => {
    const period = Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-04T00:00:00Z"));

    expect(dates(period.excludeStart())).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
    expect(dates(period.excludeEnd())).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("works in a for…of loop", () => {
    const seen: string[] = [];

    for (const day of Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-03T00:00:00Z"))) {
      seen.push(day.toISODate());
    }

    expect(seen).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("yields a single element when start and end coincide", () => {
    expect(dates(Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-01T00:00:00Z")))).toEqual([
      "2026-08-01",
    ]);
  });

  it("stops before overshooting an end the step cannot land on", () => {
    // Two-day steps from the 1st reach the 5th, not the 6th.
    const period = Period.between(
      at("2026-08-01T00:00:00Z"),
      at("2026-08-06T00:00:00Z"),
      Duration.days(2),
    );

    expect(dates(period)).toEqual(["2026-08-01", "2026-08-03", "2026-08-05"]);
  });
});

describe("Period anchoring", () => {
  it("does not let month clamping accumulate", () => {
    // Cumulative stepping would give 31 Jan, 28 Feb, 28 Mar, 28 Apr. The
    // sequence would fall off the end of the month permanently.
    const period = Period.months(at("2026-01-31T00:00:00Z"), at("2026-05-01T00:00:00Z"));

    expect(dates(period)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("computes any element directly", () => {
    const period = Period.months(at("2026-01-31T00:00:00Z"), at("2026-12-31T00:00:00Z"));

    expect(period.at(0).toISODate()).toBe("2026-01-31");
    expect(period.at(1).toISODate()).toBe("2026-02-28");
    expect(period.at(2).toISODate()).toBe("2026-03-31");
  });
});

describe("Period bounds", () => {
  it("supports a recurrence count instead of an end", () => {
    const period = Period.recurring(at("2026-08-01T00:00:00Z"), Duration.weeks(1), 3);

    expect(dates(period)).toEqual(["2026-08-01", "2026-08-08", "2026-08-15"]);
    expect(period.count()).toBe(3);
  });

  it("reports which bound it carries", () => {
    const counted = Period.recurring(at("2026-08-01T00:00:00Z"), Duration.weeks(1), 3);
    const ended = Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-04T00:00:00Z"));

    expect(counted.recurrences).toBe(3);
    expect(counted.end).toBeNull();
    expect(ended.recurrences).toBeNull();
    expect(ended.end?.toISODate()).toBe("2026-08-04");
  });

  it("caps an ended period with take()", () => {
    const period = Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z")).take(3);

    expect(dates(period)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("iterates backwards when the step is negative", () => {
    const period = Period.between(
      at("2026-08-05T00:00:00Z"),
      at("2026-08-03T00:00:00Z"),
      Duration.days(-1),
    );

    expect(dates(period)).toEqual(["2026-08-05", "2026-08-04", "2026-08-03"]);
  });

  it("rejects a step pointing away from the end", () => {
    expect(() =>
      Period.between(at("2026-08-01T00:00:00Z"), at("2026-08-05T00:00:00Z"), Duration.days(-1)),
    ).toThrow(/moves away from the end/);
  });

  it("rejects a step that does not move", () => {
    expect(() =>
      Period.between(at("2026-08-01T00:00:00Z"), at("2026-08-05T00:00:00Z"), Duration.days(0)),
    ).toThrow(/never terminate/);
  });

  it("rejects a negative recurrence count", () => {
    expect(() => Period.recurring(at("2026-08-01T00:00:00Z"), Duration.days(1), -1)).toThrow(
      /non-negative integer/,
    );
  });
});

describe("Period transformation", () => {
  const august = Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-10T00:00:00Z"));

  it("changes the step with every()", () => {
    expect(dates(august.every(Duration.days(3)))).toEqual([
      "2026-08-01",
      "2026-08-04",
      "2026-08-07",
      "2026-08-10",
    ]);
  });

  it("filters, and composes filters", () => {
    const mondays = august.filter((date) => date.isMonday());
    expect(dates(mondays)).toEqual(["2026-08-03", "2026-08-10"]);

    const composed = august.filter((date) => date.isWeekday()).filter((date) => date.day % 2 === 0);
    expect(dates(composed)).toEqual(["2026-08-04", "2026-08-06", "2026-08-10"]);
  });

  it("filters to business days", () => {
    expect(dates(august.businessDaysOnly())).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-10",
    ]);
  });

  it("maps and folds", () => {
    expect(august.take(3).map((date) => date.day)).toEqual([1, 2, 3]);
    expect(august.first()?.toISODate()).toBe("2026-08-01");
    expect(august.last()?.toISODate()).toBe("2026-08-10");
    expect(august.count()).toBe(10);
  });

  it("reports membership without materialising the whole sequence", () => {
    expect(august.includes(at("2026-08-05T00:00:00Z"))).toBe(true);
    expect(august.includes(at("2026-08-05T12:00:00Z"))).toBe(false);
    expect(august.includes(at("2026-09-05T00:00:00Z"))).toBe(false);
  });

  it("returns null bounds for an empty sequence", () => {
    const none = august.filter(() => false).take(0);

    expect(none.first()).toBeNull();
    expect(none.last()).toBeNull();
    expect(none.count()).toBe(0);
  });
});

describe("Period and Interval", () => {
  it("respects the interval's half-open end", () => {
    const interval = Interval.between(at("2026-08-01T00:00:00Z"), at("2026-08-04T00:00:00Z"));

    // The interval excludes the 4th, so the period must too, otherwise the
    // two abstractions would disagree about the same span.
    expect(dates(Period.fromInterval(interval))).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
});

describe("Period safety", () => {
  // Exhausting the default 100k-step budget is real work: ~1.5s on an idle
  // machine, and well past vitest's 5s default when the rest of the suite is
  // saturating the CPU. The budget is the thing under test, so raise the
  // timeout rather than shrink it. `maxSteps` is covered cheaply below.
  it("refuses to run away when a filter rejects everything", () => {
    const period = Period.recurring(at("2026-08-01T00:00:00Z"), Duration.days(1), 5)
      .filter(() => false)
      .take(1);

    expect(() => period.toArray()).toThrow(/exceeded 100000 steps/);
  }, 30_000);

  it("honours a custom step budget", () => {
    const period = Period.recurring(at("2026-08-01T00:00:00Z"), Duration.days(1), 5, {
      maxSteps: 10,
    })
      .filter(() => false)
      .take(1);

    expect(() => period.toArray()).toThrow(/exceeded 10 steps/);
  });

  it("keeps a custom step budget through option changes", () => {
    const period = Period.recurring(at("2026-08-01T00:00:00Z"), Duration.days(1), 5, {
      maxSteps: 10,
    })
      .filter(() => false)
      .take(1)
      .excludeStart();

    expect(() => period.toArray()).toThrow(/exceeded 10 steps/);
  });
});

describe("Period across a DST transition", () => {
  it("keeps the local time of day when stepping by days", () => {
    const period = Period.days(
      DateTime.parse("2026-03-07T09:00:00", "America/New_York"),
      DateTime.parse("2026-03-09T09:00:00", "America/New_York"),
    );

    // Every element reads 09:00 locally even though the middle step is only
    // 23 real hours.
    expect(period.map((date) => date.format("yyyy-MM-dd HH:mm"))).toEqual([
      "2026-03-07 09:00",
      "2026-03-08 09:00",
      "2026-03-09 09:00",
    ]);
  });

  it("keeps exact spacing when stepping by hours", () => {
    const period = Period.recurring(
      DateTime.parse("2026-03-08T00:00:00", "America/New_York"),
      Duration.hours(1),
      4,
    );

    // 01:00 is followed by 03:00: the 02:00 hour does not exist.
    expect(period.map((date) => date.format("HH:mm"))).toEqual([
      "00:00",
      "01:00",
      "03:00",
      "04:00",
    ]);
  });
});

describe("Period immutability", () => {
  it("never mutates the receiver", () => {
    const original = Period.days(at("2026-08-01T00:00:00Z"), at("2026-08-05T00:00:00Z"));

    original.take(2);
    original.filter(() => false);
    original.excludeStart();

    expect(original.count()).toBe(5);
    expect(Object.isFrozen(original)).toBe(true);
  });
});
