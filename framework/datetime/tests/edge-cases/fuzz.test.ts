/**
 * Plan §8's "fuzzing malformed input", done with a deterministic mutator.
 *
 * The property under test is not "these particular strings fail". It is the
 * package-wide contract from `errors.ts`:
 *
 * 1. A throwing entry point throws a `DateTimeError`, never a raw
 *    `TypeError`, `RangeError`, or a stray `date-fns` internal.
 * 2. A `*Safe` entry point never throws at all.
 * 3. Nothing ever yields a `DateTime` that is internally invalid. There is no
 *    "Invalid Date" state to leak, and this is where that claim is checked
 *    against adversarial input rather than assumed.
 *
 * Seeding keeps failures reproducible: a fuzz failure you cannot re-run is
 * only marginally better than no test at all.
 */

import { describe, expect, it } from "vitest";

import { DateTime } from "../../src/date-time.js";
import { DateTimeError } from "../../src/errors.js";
import { Interval } from "../../src/interval.js";

/** Deterministic pseudo-random source; same sequence on every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 0x1_0000_0000;
  };
}

const random = makeRandom(20260821);

const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

/** Seeds that are *nearly* valid, because those are the dangerous ones. */
const SEEDS = [
  "2026-08-20",
  "2026-08-20T14:30:00Z",
  "2026-08-20T14:30:00.123+08:00",
  "2026-08-20 14:30:00",
  "1970-01-01T00:00:00Z",
  "+002026-08-20T00:00:00Z",
];

const NOISE = [
  "",
  " ",
  "T",
  "Z",
  "-",
  ":",
  ".",
  "+",
  "99",
  "0",
  "\u0000",
  "\uFFFD",
  "e10",
  "NaN",
  "Infinity",
  "٢٠٢٦",
  "🙂",
];

/** Truncate, splice, duplicate, or substitute, the usual suspects. */
function mutate(input: string): string {
  const at = Math.floor(random() * (input.length + 1));

  switch (Math.floor(random() * 5)) {
    case 0:
      return input.slice(0, at);
    case 1:
      return input.slice(0, at) + pick(NOISE) + input.slice(at);
    case 2:
      return input.slice(0, at) + input.slice(at + 1);
    case 3:
      return input + input.slice(at);
    default:
      return input.slice(0, at) + pick(NOISE) + input.slice(at + 1);
  }
}

const CASES = Array.from({ length: 3000 }, () => {
  let value = pick(SEEDS);
  const rounds = 1 + Math.floor(random() * 3);

  for (let i = 0; i < rounds; i++) {
    value = mutate(value);
  }

  return value;
});

/** A `DateTime` that survived parsing must be coherent in every respect. */
function assertCoherent(date: DateTime, source: unknown): void {
  expect(Number.isFinite(date.epochMilliseconds), `finite instant for ${String(source)}`).toBe(
    true,
  );
  expect(Number.isInteger(date.year), `integral year for ${String(source)}`).toBe(true);
  expect(date.month >= 1 && date.month <= 12).toBe(true);
  expect(date.day >= 1 && date.day <= 31).toBe(true);
  expect(date.hour >= 0 && date.hour <= 23).toBe(true);
  expect(date.toISOString()).not.toContain("Invalid");
  expect(date.toDate().toString()).not.toBe("Invalid Date");
}

describe("fuzzing", () => {
  it("either parses a coherent DateTime or throws a DateTimeError", () => {
    for (const input of CASES) {
      let parsed: DateTime | null = null;

      try {
        parsed = DateTime.parse(input, "UTC");
      } catch (error) {
        // The contract: every failure is one of ours, with a message a caller
        // can act on. A leaked `RangeError` from a dependency would fail here.
        expect(error, `while parsing ${JSON.stringify(input)}`).toBeInstanceOf(DateTimeError);
        expect((error as Error).message.length).toBeGreaterThan(0);
        continue;
      }

      assertCoherent(parsed, input);
    }
  });

  it("agrees with parseSafe on every input, and parseSafe never throws", () => {
    for (const input of CASES) {
      const safe = DateTime.parseSafe(input, "UTC");

      let strict: DateTime | null = null;
      try {
        strict = DateTime.parse(input, "UTC");
      } catch {
        strict = null;
      }

      expect(safe === null, `parseSafe/parse disagree on ${JSON.stringify(input)}`).toBe(
        strict === null,
      );

      if (safe !== null && strict !== null) {
        expect(safe.epochMilliseconds).toBe(strict.epochMilliseconds);
      }
    }
  });

  it("round-trips anything it accepts", () => {
    for (const input of CASES) {
      const parsed = DateTime.parseSafe(input, "UTC");

      if (parsed === null) {
        continue;
      }

      // Whatever it accepted must survive its own serialization, or the
      // parser and the formatter disagree about what was meant.
      const revived = DateTime.parse(parsed.toISOString(), "UTC");
      expect(revived.epochMilliseconds, `round trip of ${JSON.stringify(input)}`).toBe(
        parsed.epochMilliseconds,
      );
    }
  });

  it("rejects non-string junk the same way", () => {
    const junk: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(Number.NaN),
      "",
      "   ",
      "0000-00-00",
      "2026-13-01",
      "2026-02-30",
      "2026-08-20T25:00:00Z",
      "2026-08-20T14:60:00Z",
      "2026-08-20T14:30:00+25:00",
    ];

    for (const value of junk) {
      expect(() => DateTime.parse(value as never), `parsing ${String(value)}`).toThrow(
        DateTimeError,
      );
      expect(DateTime.parseSafe(value as never)).toBeNull();
    }
  });

  it("rejects unknown timezones rather than falling back to UTC", () => {
    for (const zone of ["Mars/Olympus_Mons", "", "UTC+8", "Australia/Perthh", "🙂"]) {
      expect(() => DateTime.now(zone), `zone ${zone}`).toThrow(DateTimeError);
    }
  });

  it("keeps format-directed parsing inside the same contract", () => {
    for (const input of CASES.slice(0, 500)) {
      let parsed: DateTime | null = null;

      try {
        parsed = DateTime.createFromFormat(input, "yyyy-MM-dd", "UTC");
      } catch (error) {
        expect(error, `while parsing ${JSON.stringify(input)}`).toBeInstanceOf(DateTimeError);
        continue;
      }

      assertCoherent(parsed, input);
      // Strict mode is the default, so anything accepted must render back
      // to exactly what was supplied.
      expect(parsed.format("yyyy-MM-dd")).toBe(input.trim());
    }
  });

  it("keeps derived objects coherent too", () => {
    for (const input of CASES) {
      const parsed = DateTime.parseSafe(input, "UTC");

      if (parsed === null) {
        continue;
      }

      const interval = Interval.around(parsed, parsed.addDays(1));
      expect(interval.lengthMs).toBeGreaterThanOrEqual(0);
      expect(interval.contains(interval.start) || interval.isEmpty).toBe(true);
    }
  });
});
