/**
 * Plan §33. Run with `pnpm --filter @mahi/datetime bench`.
 *
 * The point of these is not a number to put in a README. It is to catch the
 * shape of a regression: `format()` and `parse()` cross the `Intl` boundary
 * and are two orders of magnitude slower than instant arithmetic, so a change
 * that accidentally routes `addHours()` through a formatter would show up
 * here as a cliff rather than as a mysteriously slow application.
 *
 * `now()` is measured against a frozen clock elsewhere in the suite; here it
 * uses the real one, since `Date.now()` is part of what is being measured.
 */

import { bench, describe } from "vitest";

import { DateTime } from "../src/date-time.js";
import { Duration } from "../src/duration.js";
import { Interval } from "../src/interval.js";
import { Period } from "../src/period.js";

const utc = DateTime.parse("2026-08-20T14:30:00Z", "UTC");
const perth = DateTime.parse("2026-08-20T14:30:00Z", "Australia/Perth");
const newYork = DateTime.parse("2026-03-08T00:00:00", "America/New_York");
const other = DateTime.parse("2027-02-13T08:15:00Z", "UTC");

describe("construction", () => {
  bench("now()", () => {
    DateTime.now("UTC");
  });

  bench("fromTimestamp()", () => {
    DateTime.fromTimestamp(1_787_236_200_000, "UTC");
  });

  bench("parse(ISO)", () => {
    DateTime.parse("2026-08-20T14:30:00Z", "UTC");
  });

  bench("parse(ISO) into a DST zone", () => {
    DateTime.parse("2026-08-20T14:30:00", "America/New_York");
  });

  bench("createFromFormat()", () => {
    DateTime.createFromFormat("20/08/2026 14:30", "dd/MM/yyyy HH:mm", "UTC");
  });
});

describe("arithmetic", () => {
  // Exact arithmetic never touches a calendar or a zone; calendar arithmetic
  // re-resolves the wall clock. The gap between these two is the number worth
  // watching.
  bench("addHours() — exact", () => {
    utc.addHours(3);
  });

  bench("addDays() — calendar, fixed-offset zone", () => {
    utc.addDays(3);
  });

  bench("addDays() — calendar, DST zone", () => {
    newYork.addDays(3);
  });

  bench("addMonths()", () => {
    utc.addMonths(3);
  });

  bench("add(Duration)", () => {
    utc.add(Duration.days(2).addHours(4));
  });
});

describe("reading", () => {
  bench("component getters (cold)", () => {
    const date = DateTime.fromTimestamp(1_787_236_200_000, "Australia/Perth");
    void date.year;
    void date.month;
    void date.day;
  });

  bench("component getters (memoised)", () => {
    void perth.year;
    void perth.month;
    void perth.day;
  });

  bench("offset", () => {
    void perth.offset;
  });
});

describe("boundaries and comparison", () => {
  bench("startOfDay()", () => {
    utc.startOfDay();
  });

  bench("startOfMonth()", () => {
    utc.startOfMonth();
  });

  bench("isBefore()", () => {
    utc.isBefore(other);
  });

  bench("isSameDay()", () => {
    utc.isSameDay(other);
  });
});

describe("differences", () => {
  bench("diffInHours() — exact", () => {
    utc.diffInHours(other);
  });

  bench("diffInDays() — calendar", () => {
    utc.diffInDays(other);
  });

  bench("diffInMonths() — stepped", () => {
    utc.diffInMonths(other);
  });
});

describe("timezones", () => {
  bench("inTimezone() — relabel only", () => {
    utc.inTimezone("Asia/Tokyo");
  });

  bench("keepLocalTime() — re-resolve", () => {
    utc.keepLocalTime("Asia/Tokyo");
  });
});

describe("formatting and serialization", () => {
  bench("format()", () => {
    utc.format("yyyy-MM-dd HH:mm:ss");
  });

  bench("toISOString()", () => {
    utc.toISOString();
  });

  bench("toLocaleString()", () => {
    utc.toLocaleString({ dateStyle: "medium" }, "en");
  });

  bench("diffForHumans()", () => {
    utc.diffForHumans(other);
  });

  bench("toObject()", () => {
    utc.toObject();
  });
});

describe("collections", () => {
  const month = Period.days(
    DateTime.parse("2026-08-01T00:00:00Z", "UTC"),
    DateTime.parse("2026-08-31T00:00:00Z", "UTC"),
  );

  bench("Period of 31 days → array", () => {
    month.toArray();
  });

  bench("Period of 31 days, filtered to business days", () => {
    month.businessDaysOnly().toArray();
  });

  bench("Interval.between() + contains()", () => {
    Interval.between(utc, other).contains(perth);
  });
});
