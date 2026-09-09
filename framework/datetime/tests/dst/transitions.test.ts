/**
 * Plan §12. Every transition instant below was read off the host's own tzdata
 * before being written down, rather than assumed from the usual rules — the
 * usual rules are exactly what goes stale.
 *
 * Reference transitions used here:
 *   America/New_York   2026-03-08 07:00Z  −05 → −04   (02:00 local → 03:00)
 *                      2026-11-01 06:00Z  −04 → −05   (02:00 local → 01:00)
 *   Europe/London      2026-03-29 01:00Z  +00 → +01
 *                      2026-10-25 01:00Z  +01 → +00
 *   Australia/Sydney   2026-10-03 16:00Z  +10 → +11   (southern spring)
 *                      2026-04-04 16:00Z  +11 → +10   (southern autumn)
 *   Australia/Lord_Howe 2026-10-03 16:00Z +10:30 → +11 (a 30-minute jump)
 *   America/Sao_Paulo  2018-11-04 03:00Z  −03 → −02   (midnight itself skipped)
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { AmbiguousTimeError } from "../../src/errors.js";

const NY = "America/New_York";

describe("spring forward: a wall clock that never happens", () => {
  const gap = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 };

  it("shifts forward out of the gap by default", () => {
    const resolved = DateTime.fromComponents(gap, NY);

    expect(resolved.toISOString()).toBe("2026-03-08T03:30:00.000-04:00");
    expect(resolved.utc().toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("shifts backward under the earlier policy", () => {
    const resolved = DateTime.fromComponents(gap, NY, { disambiguation: "earlier" });

    expect(resolved.toISOString()).toBe("2026-03-08T01:30:00.000-05:00");
  });

  it("agrees with compatible under the later policy", () => {
    const resolved = DateTime.fromComponents(gap, NY, { disambiguation: "later" });

    expect(resolved.toISOString()).toBe("2026-03-08T03:30:00.000-04:00");
  });

  it("refuses to guess under the reject policy", () => {
    expect(() => DateTime.fromComponents(gap, NY, { disambiguation: "reject" })).toThrow(
      AmbiguousTimeError,
    );

    try {
      DateTime.fromComponents(gap, NY, { disambiguation: "reject" });
    } catch (error) {
      expect((error as AmbiguousTimeError).kind).toBe("nonexistent");
      expect((error as AmbiguousTimeError).message).toContain("does not exist");
    }
  });

  it("resolves times either side of the gap without shifting them", () => {
    expect(DateTime.parse("2026-03-08T01:59:59", NY).toISOString()).toBe(
      "2026-03-08T01:59:59.000-05:00",
    );
    expect(DateTime.parse("2026-03-08T03:00:00", NY).toISOString()).toBe(
      "2026-03-08T03:00:00.000-04:00",
    );
  });

  it("handles a 30-minute jump, not just whole hours", () => {
    // Lord Howe Island shifts by half an hour at 02:00, so the missing window
    // is 02:00-02:29 and 02:45 is a perfectly real time.
    const inGap = DateTime.parse("2026-10-04T02:15:00", "Australia/Lord_Howe");
    const real = DateTime.parse("2026-10-04T02:45:00", "Australia/Lord_Howe");

    expect(inGap.toISOString()).toBe("2026-10-04T02:45:00.000+11:00");
    expect(real.toISOString()).toBe("2026-10-04T02:45:00.000+11:00");
    // The two agree only because the gap collapses onto the same instant;
    // one was shifted, the other was not.
    expect(DateTime.parse("2026-10-04T01:59:00", "Australia/Lord_Howe").offset).toBe(
      10.5 * 3_600_000,
    );
  });

  it("handles a zone that skips midnight itself", () => {
    // São Paulo moved its clocks at midnight, so 2018-11-04 00:30 never
    // happened and there is no such thing as the start of that day.
    const resolved = DateTime.parse("2018-11-04T00:30:00", "America/Sao_Paulo");

    expect(resolved.toISOString()).toBe("2018-11-04T01:30:00.000-02:00");
    expect(
      DateTime.parse("2018-11-04T12:00:00", "America/Sao_Paulo").startOfDay().toISOString(),
    ).toBe("2018-11-04T01:00:00.000-02:00");
  });
});

describe("fall back: a wall clock that happens twice", () => {
  const overlap = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, millisecond: 0 };

  it("takes the first occurrence by default", () => {
    const resolved = DateTime.fromComponents(overlap, NY);

    expect(resolved.toISOString()).toBe("2026-11-01T01:30:00.000-04:00");
    expect(resolved.utc().toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("takes the second occurrence under the later policy", () => {
    const resolved = DateTime.fromComponents(overlap, NY, { disambiguation: "later" });

    expect(resolved.toISOString()).toBe("2026-11-01T01:30:00.000-05:00");
    expect(resolved.utc().toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("puts the two occurrences exactly one hour apart", () => {
    const first = DateTime.fromComponents(overlap, NY, { disambiguation: "earlier" });
    const second = DateTime.fromComponents(overlap, NY, { disambiguation: "later" });

    expect(second.epochMilliseconds - first.epochMilliseconds).toBe(3_600_000);
    expect(first.hour).toBe(second.hour);
    expect(first.isEqual(second)).toBe(false);
  });

  it("refuses to guess under the reject policy", () => {
    try {
      DateTime.fromComponents(overlap, NY, { disambiguation: "reject" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousTimeError);
      expect((error as AmbiguousTimeError).kind).toBe("ambiguous");
      expect((error as AmbiguousTimeError).message).toContain("occurs twice");
    }
  });
});

describe("arithmetic across a transition", () => {
  it("preserves the wall clock when adding days", () => {
    const before = DateTime.parse("2026-03-07T09:00:00", NY);
    const after = before.addDays(1);

    expect(after.toISODate()).toBe("2026-03-08");
    expect(after.hour).toBe(9);
    // One calendar day, but only 23 real hours.
    expect(after.epochMilliseconds - before.epochMilliseconds).toBe(23 * 3_600_000);
  });

  it("preserves elapsed time when adding hours", () => {
    const before = DateTime.parse("2026-03-08T00:00:00", NY);
    const after = before.addHours(24);

    expect(after.epochMilliseconds - before.epochMilliseconds).toBe(24 * 3_600_000);
    // The wall clock lands an hour later than the naive expectation.
    expect(after.toISOString()).toBe("2026-03-09T01:00:00.000-04:00");
  });

  it("gains an hour going the other way", () => {
    const before = DateTime.parse("2026-10-31T09:00:00", NY);

    expect(before.addDays(1).epochMilliseconds - before.epochMilliseconds).toBe(25 * 3_600_000);
  });

  it("lands on a wall clock inside the gap and shifts out of it", () => {
    // 02:30 on 7 March plus a day would be 02:30 on the 8th, which does not
    // exist; the default policy moves it to 03:30 rather than failing.
    const result = DateTime.parse("2026-03-07T02:30:00", NY).addDays(1);

    expect(result.toISOString()).toBe("2026-03-08T03:30:00.000-04:00");
  });

  it("adds months and years across transitions without drift", () => {
    const date = DateTime.parse("2026-01-15T09:00:00", NY);

    expect(date.addMonths(6).toISOString()).toBe("2026-07-15T09:00:00.000-04:00");
    expect(date.addYears(1).toISOString()).toBe("2027-01-15T09:00:00.000-05:00");
  });

  it("behaves the same in the southern hemisphere", () => {
    // Sydney springs forward on 4 October and falls back on 5 April.
    const spring = DateTime.parse("2026-10-03T09:00:00", "Australia/Sydney");
    const autumn = DateTime.parse("2026-04-04T09:00:00", "Australia/Sydney");

    expect(spring.addDays(1).epochMilliseconds - spring.epochMilliseconds).toBe(23 * 3_600_000);
    expect(autumn.addDays(1).epochMilliseconds - autumn.epochMilliseconds).toBe(25 * 3_600_000);
  });
});

describe("boundaries across a transition", () => {
  it("gives a 23-hour day on spring forward", () => {
    const day = DateTime.parse("2026-03-08T12:00:00", NY);

    expect(day.startOfDay().toISOString()).toBe("2026-03-08T00:00:00.000-05:00");
    expect(day.endOfDay().toISOString()).toBe("2026-03-08T23:59:59.999-04:00");
    expect(day.endOfDay().diffInHours(day.startOfDay())).toBe(-22);
  });

  it("gives a 25-hour day on fall back, ending after the second 01:00", () => {
    const day = DateTime.parse("2026-11-01T12:00:00", NY);
    const start = day.startOfDay();
    const end = day.endOfDay();

    expect(start.toISOString()).toBe("2026-11-01T00:00:00.000-04:00");
    expect(end.toISOString()).toBe("2026-11-01T23:59:59.999-05:00");
    expect(end.epochMilliseconds - start.epochMilliseconds).toBe(25 * 3_600_000 - 1);
  });

  it("keeps startOfMonth and endOfMonth correct across a transition", () => {
    const march = DateTime.parse("2026-03-15T12:00:00", NY);

    expect(march.startOfMonth().toISOString()).toBe("2026-03-01T00:00:00.000-05:00");
    expect(march.endOfMonth().toISOString()).toBe("2026-03-31T23:59:59.999-04:00");
  });
});

describe("conversion and differences across a transition", () => {
  it("converts an instant into a zone that is mid-transition", () => {
    const instant = DateTime.parse("2026-03-08T07:30:00Z", "UTC");

    expect(instant.inTimezone(NY).toISOString()).toBe("2026-03-08T03:30:00.000-04:00");
    expect(instant.subHours(1).inTimezone(NY).toISOString()).toBe("2026-03-08T01:30:00.000-05:00");
  });

  it("keeps the wall clock when asked to, changing the instant", () => {
    const sydney = DateTime.parse("2026-04-05T09:00:00", "Australia/Sydney");
    const moved = sydney.keepLocalTime(NY);

    expect(moved.hour).toBe(9);
    expect(moved.toISODate()).toBe("2026-04-05");
    expect(moved.isEqual(sydney)).toBe(false);
  });

  it("reports elapsed hours and calendar days differently", () => {
    const start = DateTime.parse("2026-11-01T00:00:00", NY);
    const end = DateTime.parse("2026-11-02T00:00:00", NY);

    expect(start.diffInDays(end)).toBe(1);
    expect(start.diffInHours(end)).toBe(25);
  });

  it("identifies whether a zone is on daylight saving at an instant", () => {
    expect(DateTime.parse("2026-07-01T12:00:00", NY).isDST()).toBe(true);
    expect(DateTime.parse("2026-01-01T12:00:00", NY).isDST()).toBe(false);
    expect(DateTime.parse("2026-01-01T12:00:00", "Australia/Sydney").isDST()).toBe(true);
    expect(DateTime.parse("2026-07-01T12:00:00", "Australia/Perth").isDST()).toBe(false);
  });
});

describe("zones without daylight saving", () => {
  it.each(["Australia/Perth", "Asia/Tokyo", "UTC"])("%s keeps a constant offset", (zone) => {
    const january = DateTime.parse("2026-01-15T12:00:00", zone);
    const july = DateTime.parse("2026-07-15T12:00:00", zone);

    expect(january.offset).toBe(july.offset);
    expect(january.addDays(1).epochMilliseconds - january.epochMilliseconds).toBe(86_400_000);
  });
});
