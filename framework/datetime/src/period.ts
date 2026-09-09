/**
 * A lazily-evaluated sequence of `DateTime`s (plan §20).
 *
 * ```ts
 * for (const day of Period.days("2026-08-01", "2026-08-31")) {
 *   // 31 midnights, in the start's zone
 * }
 * ```
 *
 * ## Inclusive, unlike `Interval`
 *
 * `Interval` is half-open because it models a *span*, and half-open spans
 * tile without overlapping. A `Period` models a *list of dates*, and "every
 * day in August" plainly includes the 31st. Both bounds are therefore
 * inclusive by default, matching Carbon's `CarbonPeriod`, with
 * `excludeStart()` / `excludeEnd()` available when they aren't wanted.
 *
 * ## Anchored stepping
 *
 * Each element is computed as `start + step × index`, never by repeatedly
 * adding to the previous element. The difference shows up the moment a month
 * is involved: anchored monthly stepping from 31 January gives 31 Jan,
 * 28 Feb, 31 Mar, whereas cumulative stepping would clamp to the 28th in
 * February and then *stay* there for the rest of the year. Anchoring also
 * makes the sequence order-independent, so `at(n)` is O(1) and iteration
 * cannot drift.
 *
 * ## Bounded by construction
 *
 * Every `Period` has either an end date or a recurrence count. There is no
 * unbounded period, because the only thing you can safely do with one is
 * forget to bound it at the call site.
 */

import { DateTime, type DateTimeLike } from "./date-time.js";
import { Duration, type DurationInput } from "./duration.js";
import { InvalidIntervalError } from "./errors.js";
import type { Interval } from "./interval.js";
import type { BusinessDayOptions, TimezoneIdentifier } from "./types.js";

/** Called for each candidate; return `false` to drop it from the sequence. */
export type PeriodFilter = (date: DateTime, index: number) => boolean;

export interface PeriodOptions {
  /** Drop the start date from the sequence. @default false */
  excludeStart?: boolean;
  /** Drop an element landing exactly on the end date. @default false */
  excludeEnd?: boolean;
  /**
   * How many candidates may be examined before iteration gives up.
   *
   * A safety net for two situations: a `filter` that rejects nearly
   * everything, and a genuinely enormous sequence (every millisecond of a
   * day is 86.4 million elements). Either way a hard stop with a clear
   * message beats a hung process or an exhausted heap.
   *
   * @default 100000
   */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 100_000;

export class Period implements Iterable<DateTime> {
  private constructor(
    readonly start: DateTime,
    readonly step: Duration,
    /** Inclusive upper bound, or `null` when bounded by `limit` instead. */
    private readonly endAt: DateTime | null,
    /** Maximum number of yielded elements, or `null` when bounded by `endAt`. */
    private readonly limit: number | null,
    private readonly predicate: PeriodFilter | null,
    private readonly options: Required<PeriodOptions>,
  ) {
    Object.freeze(this);
  }

  /**
   * Every `step` from `start` up to and including `end`.
   *
   * The step must point from `start` toward `end`; a step in the wrong
   * direction would never terminate, so it is rejected rather than silently
   * producing an empty sequence that hides the mistake.
   */
  static between(
    start: DateTimeLike,
    end: DateTimeLike,
    step: Duration | DurationInput = { days: 1 },
    options: PeriodOptions = {},
  ): Period {
    const from = DateTime.parse(start);
    const to = DateTime.parse(end).inTimezone(from.timezone);
    const amount = Duration.from(step);

    assertProgress(from, amount);

    const forward = from.add(amount).isAfter(from);

    if (forward ? to.isBefore(from) : to.isAfter(from)) {
      throw new InvalidIntervalError(
        `The step ${amount.toISOString()} moves away from the end of the period ` +
          `(${from.toISOString()} → ${to.toISOString()}); it would never terminate.`,
      );
    }

    return new Period(from, amount, to, null, null, normalise(options));
  }

  /** Exactly `count` elements, starting at `start`. */
  static recurring(
    start: DateTimeLike,
    step: Duration | DurationInput,
    count: number,
    options: PeriodOptions = {},
  ): Period {
    if (!Number.isInteger(count) || count < 0) {
      throw new InvalidIntervalError(
        `A recurrence count must be a non-negative integer, got ${count}.`,
      );
    }

    const from = DateTime.parse(start);
    const amount = Duration.from(step);
    assertProgress(from, amount);

    return new Period(from, amount, null, count, null, normalise(options));
  }

  /** Every element of `interval`, stepping by `step`. Respects the half-open end. */
  static fromInterval(
    interval: Interval,
    step: Duration | DurationInput = { days: 1 },
    options: PeriodOptions = {},
  ): Period {
    // An `Interval` excludes its end; a `Period` includes it. Passing
    // `excludeEnd` through is what keeps the two consistent.
    return Period.between(interval.start, interval.end, step, { ...options, excludeEnd: true });
  }
  // Unit-named shorthands for `between`, each stepping by one of that unit.
  static milliseconds(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { milliseconds: 1 }, options);
  }
  static seconds(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { seconds: 1 }, options);
  }
  static minutes(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { minutes: 1 }, options);
  }
  static hours(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { hours: 1 }, options);
  }
  static days(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { days: 1 }, options);
  }
  static weeks(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { weeks: 1 }, options);
  }
  static months(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { months: 1 }, options);
  }
  static quarters(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { quarters: 1 }, options);
  }
  static years(start: DateTimeLike, end: DateTimeLike, options?: PeriodOptions): Period {
    return Period.between(start, end, { years: 1 }, options);
  }

  /** The same bounds with a different step. */
  every(step: Duration | DurationInput): Period {
    const amount = Duration.from(step);
    assertProgress(this.start, amount);

    return this.endAt === null
      ? Period.recurring(this.start, amount, this.limit ?? 0, this.options).withFilter(
          this.predicate,
        )
      : Period.between(this.start, this.endAt, amount, this.options).withFilter(this.predicate);
  }

  /** Cap the sequence at `count` yielded elements. */
  take(count: number): Period {
    if (!Number.isInteger(count) || count < 0) {
      throw new InvalidIntervalError(`take() requires a non-negative integer, got ${count}.`);
    }

    const limit = this.limit === null ? count : Math.min(this.limit, count);

    return new Period(this.start, this.step, this.endAt, limit, this.predicate, this.options);
  }

  /** Replace the inclusive end bound. */
  until(end: DateTimeLike): Period {
    return Period.between(this.start, end, this.step, this.options).withFilter(this.predicate);
  }

  /**
   * Keep only the elements matching `predicate`.
   *
   * Composes: calling `filter` twice requires both predicates to pass. The
   * index handed to the predicate counts *candidates*, not survivors, so it
   * stays stable as further filters are layered on.
   */
  filter(predicate: PeriodFilter): Period {
    const existing = this.predicate;
    const combined: PeriodFilter =
      existing === null
        ? predicate
        : (date, index) => existing(date, index) && predicate(date, index);

    return new Period(this.start, this.step, this.endAt, this.limit, combined, this.options);
  }

  /** Only business days, per the same options `DateTime.isBusinessDay` takes. */
  businessDaysOnly(options: BusinessDayOptions = {}): Period {
    return this.filter((date) => date.isBusinessDay(options));
  }

  excludeStart(): Period {
    return this.withOptions({ excludeStart: true });
  }

  excludeEnd(): Period {
    return this.withOptions({ excludeEnd: true });
  }

  private withOptions(patch: PeriodOptions): Period {
    // Spreading `patch` directly rather than a normalised copy: filling in
    // defaults here would let `excludeStart()` silently reset an explicitly
    // configured `maxSteps`.
    return new Period(this.start, this.step, this.endAt, this.limit, this.predicate, {
      ...this.options,
      ...patch,
    });
  }

  private withFilter(predicate: PeriodFilter | null): Period {
    return predicate === null ? this : this.filter(predicate);
  }

  *[Symbol.iterator](): Iterator<DateTime> {
    let index = 0;
    let yielded = 0;

    while (true) {
      if (index >= this.options.maxSteps) {
        throw new InvalidIntervalError(
          `Period exceeded ${this.options.maxSteps} steps without terminating. ` +
            `Either the sequence is larger than expected or a filter is ` +
            `rejecting nearly everything; raise maxSteps if it really is that big.`,
        );
      }

      const candidate = this.at(index);

      if (this.endAt !== null && this.isBeyondEnd(candidate)) {
        return;
      }

      if (this.limit !== null && yielded >= this.limit) {
        return;
      }

      const skipStart = index === 0 && this.options.excludeStart;
      const skipEnd =
        this.options.excludeEnd && this.endAt !== null && candidate.isEqual(this.endAt);
      const rejected = this.predicate !== null && !this.predicate(candidate, index);

      if (!skipStart && !skipEnd && !rejected) {
        yield candidate;
        yielded++;
      }

      index++;
    }
  }

  /** The `index`-th candidate, ignoring filters and bounds. O(1). */
  at(index: number): DateTime {
    return index === 0 ? this.start : this.start.add(this.step.multiply(index));
  }

  toArray(): DateTime[] {
    return [...this];
  }

  map<T>(transform: (date: DateTime, index: number) => T): T[] {
    return this.toArray().map(transform);
  }

  forEach(visit: (date: DateTime, index: number) => void): void {
    this.toArray().forEach(visit);
  }

  /** How many elements the sequence yields. Fully evaluates it. */
  count(): number {
    return this.toArray().length;
  }

  /** The first element, or `null` when the sequence is empty. */
  first(): DateTime | null {
    for (const date of this) {
      return date;
    }

    return null;
  }

  /** The last element, or `null` when the sequence is empty. */
  last(): DateTime | null {
    let result: DateTime | null = null;

    for (const date of this) {
      result = date;
    }

    return result;
  }

  /** Whether `instant` is one of the yielded elements. */
  includes(instant: DateTimeLike): boolean {
    const target = DateTime.parse(instant).epochMilliseconds;

    for (const date of this) {
      if (date.epochMilliseconds === target) {
        return true;
      }

      // The sequence is monotonic, so passing the target means it is absent.
      if (this.movesForward ? date.epochMilliseconds > target : date.epochMilliseconds < target) {
        return false;
      }
    }

    return false;
  }

  get timezone(): TimezoneIdentifier {
    return this.start.timezone;
  }

  /**
   * The configured element cap, or `null` when the sequence is bounded by an
   * end date instead. Carbon's `CarbonPeriod::recurrences()`, read-only —
   * use `take()` to change it.
   */
  get recurrences(): number | null {
    return this.limit;
  }

  /** The inclusive end bound, or `null` when bounded by a count instead. */
  get end(): DateTime | null {
    return this.endAt;
  }

  private get movesForward(): boolean {
    return this.at(1).isAfter(this.start);
  }

  private isBeyondEnd(candidate: DateTime): boolean {
    if (this.endAt === null) {
      return false;
    }

    return this.movesForward ? candidate.isAfter(this.endAt) : candidate.isBefore(this.endAt);
  }

  toString(): string {
    const bound = this.endAt === null ? `×${this.limit}` : `→ ${this.endAt.toISOString()}`;

    return `Period(${this.start.toISOString()} ${bound}, every ${this.step.toISOString()})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** A step that doesn't move is an infinite loop waiting to be discovered. */
function assertProgress(start: DateTime, step: Duration): void {
  if (start.add(step).isEqual(start)) {
    throw new InvalidIntervalError(
      "A period's step must move time forward or backward; a zero-length step " +
        "would never terminate.",
    );
  }
}

function normalise(options: PeriodOptions): Required<PeriodOptions> {
  return {
    excludeStart: options.excludeStart ?? false,
    excludeEnd: options.excludeEnd ?? false,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
  };
}
