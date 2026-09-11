import { describe, expect, it } from "vitest";
import {
  isCompiledCronDue,
  nextCronRun,
  parseCronExpression,
  type CompiledCron,
} from "../src/cron-matcher.js";

/**
 * `nextCronRun()` skips whole days and hours it can prove cannot match,
 * which is what keeps a once-a-year expression from costing half a million
 * iterations. Those skips are also the easiest thing in this package to
 * get subtly wrong — a jump one hour too far silently loses a run, and
 * nothing about the result looks unusual when it happens.
 *
 * So it is checked against a reference implementation that does the
 * obviously-correct, unbearably-slow thing: step one minute at a time and
 * ask `isCompiledCronDue()`. Any disagreement is a bug in the skipping.
 *
 * The matrix here is deliberately small enough to run in the normal suite.
 * It was developed against a much larger one (every hour of every 13th day
 * across a year, five zones, ~350k reference iterations per case) which
 * agreed on all 90 combinations; this is the fast residue of that.
 */
function referenceNextRun(
  cron: CompiledCron,
  from: Date,
  timeZone: string | undefined,
  limitMinutes: number,
): Date | undefined {
  let cursor = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;

  for (let i = 0; i < limitMinutes; i++) {
    const date = new Date(cursor);

    if (isCompiledCronDue(cron, date, timeZone)) {
      return date;
    }

    cursor += 60_000;
  }

  return undefined;
}

const EXPRESSIONS = [
  "* * * * *",
  "0 0 * * *",
  "*/5 * * * *",
  "0 9 * * 1-5",
  "30 2 1 * *", // a wall-clock time DST can skip, on one day a month
  "0 0 L * *",
  "0 0 1 * 1", // the day-of-month/day-of-week OR
  "0 0 * * 7", // 7 = Sunday
  "15,45 9-17 * * MON-FRI",
  "0 12 1,15 * *",
  "*/7 */3 * * *",
];

const ZONES: Array<string | undefined> = [
  undefined, // server-local
  "UTC",
  "America/New_York", // DST, whole-hour shift
  "Australia/Lord_Howe", // DST, THIRTY-MINUTE shift
];

describe("nextCronRun agrees with a minute-by-minute reference scan", () => {
  for (const expression of EXPRESSIONS) {
    for (const timeZone of ZONES) {
      it(`${expression} @ ${timeZone ?? "local"}`, () => {
        const cron = parseCronExpression(expression);

        // Starts spread across a year, at hours either side of the DST
        // transitions (which happen in the small hours).
        for (let day = 0; day < 370; day += 97) {
          for (const hour of [1, 23]) {
            const from = new Date(Date.UTC(2026, 0, 1, hour, 37) + day * 86_400_000);
            // 40 days of minutes: past the longest gap any expression here
            // has, without the cost of a full year.
            const limit = 60 * 24 * 40;

            const actual = nextCronRun(cron, from, timeZone, 40);
            const expected = referenceNextRun(cron, from, timeZone, limit);

            expect(actual?.toISOString()).toBe(expected?.toISOString());
          }
        }
      });
    }
  }
});
