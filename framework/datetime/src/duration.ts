/**
 * An immutable length of time.
 *
 * ## Why three buckets and not one number
 *
 * "One month" is not a number of milliseconds. Neither, strictly, is "one
 * day" — across a daylight-saving transition a day is 23 or 25 hours. A
 * `Duration` therefore keeps three independent buckets and never silently
 * collapses them:
 *
 * - `months` — calendar-relative. One month means "the same day-of-month next
 *   month", clamped at short months. Its length in milliseconds is unknowable
 *   without a starting date.
 * - `days` — calendar-relative *when applied to a zoned `DateTime`* (the wall
 *   clock is preserved across DST), but treated as exactly 24 hours by the
 *   `total*` accessors, since that is what "how many hours is 2 days" means
 *   to everybody asking the question.
 * - `milliseconds` — exact. Never depends on a calendar or a zone.
 *
 * Years and quarters are stored as months (×12 and ×3); weeks are stored as
 * days (×7). Those conversions are exact by definition, unlike months→days.
 *
 * ## Consequences
 *
 * `Duration.months(1).totalDays` throws, because there is no honest answer.
 * `Duration.days(2).totalHours` is `48`. `DateTime.add(Duration.days(1))`
 * across a spring-forward advances the wall clock by a day and the instant by
 * 23 hours — those are both correct, and they are different questions.
 */

import { InvalidDurationError } from "./errors.js";
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MS_PER_WEEK,
} from "./internal/civil.js";

/** Every field a `Duration` can be built from. All default to `0`. */
export interface DurationInput {
  years?: number;
  quarters?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

/** The normalised three-bucket form a `Duration` actually stores. */
export interface DurationParts {
  months: number;
  days: number;
  milliseconds: number;
}

function assertFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new InvalidDurationError(`Duration.${field} must be a finite number, got ${value}.`);
  }

  return value;
}

export class Duration {
  readonly months: number;
  readonly days: number;
  readonly milliseconds: number;

  private constructor(months: number, days: number, milliseconds: number) {
    this.months = months;
    this.days = days;
    this.milliseconds = milliseconds;
    Object.freeze(this);
  }

  static from(input: DurationInput | Duration): Duration {
    if (input instanceof Duration) {
      return input;
    }

    const months =
      assertFinite(input.years ?? 0, "years") * 12 +
      assertFinite(input.quarters ?? 0, "quarters") * 3 +
      assertFinite(input.months ?? 0, "months");

    const days =
      assertFinite(input.weeks ?? 0, "weeks") * 7 + assertFinite(input.days ?? 0, "days");

    const milliseconds =
      assertFinite(input.hours ?? 0, "hours") * MS_PER_HOUR +
      assertFinite(input.minutes ?? 0, "minutes") * MS_PER_MINUTE +
      assertFinite(input.seconds ?? 0, "seconds") * MS_PER_SECOND +
      assertFinite(input.milliseconds ?? 0, "milliseconds");

    return new Duration(months, days, milliseconds);
  }

  static zero(): Duration {
    return new Duration(0, 0, 0);
  }

  static milliseconds(amount: number): Duration {
    return Duration.from({ milliseconds: amount });
  }

  static seconds(amount: number): Duration {
    return Duration.from({ seconds: amount });
  }

  static minutes(amount: number): Duration {
    return Duration.from({ minutes: amount });
  }

  static hours(amount: number): Duration {
    return Duration.from({ hours: amount });
  }

  static days(amount: number): Duration {
    return Duration.from({ days: amount });
  }

  static weeks(amount: number): Duration {
    return Duration.from({ weeks: amount });
  }

  static months(amount: number): Duration {
    return Duration.from({ months: amount });
  }

  static quarters(amount: number): Duration {
    return Duration.from({ quarters: amount });
  }

  static years(amount: number): Duration {
    return Duration.from({ years: amount });
  }

  add(other: Duration | DurationInput): Duration {
    const addend = Duration.from(other);

    return new Duration(
      this.months + addend.months,
      this.days + addend.days,
      this.milliseconds + addend.milliseconds,
    );
  }

  subtract(other: Duration | DurationInput): Duration {
    return this.add(Duration.from(other).negate());
  }

  addMilliseconds(amount: number): Duration {
    return this.add({ milliseconds: amount });
  }

  addSeconds(amount: number): Duration {
    return this.add({ seconds: amount });
  }

  addMinutes(amount: number): Duration {
    return this.add({ minutes: amount });
  }

  addHours(amount: number): Duration {
    return this.add({ hours: amount });
  }

  addDays(amount: number): Duration {
    return this.add({ days: amount });
  }

  addWeeks(amount: number): Duration {
    return this.add({ weeks: amount });
  }

  addMonths(amount: number): Duration {
    return this.add({ months: amount });
  }

  addQuarters(amount: number): Duration {
    return this.add({ quarters: amount });
  }

  addYears(amount: number): Duration {
    return this.add({ years: amount });
  }

  /** Multiplies every bucket. `Duration.hours(2).multiply(3)` is six hours. */
  multiply(factor: number): Duration {
    assertFinite(factor, "multiply factor");

    return new Duration(this.months * factor, this.days * factor, this.milliseconds * factor);
  }

  negate(): Duration {
    return new Duration(-this.months, -this.days, -this.milliseconds);
  }

  /**
   * The magnitude of the duration.
   *
   * Note this negates each bucket independently, so a mixed-sign duration
   * such as "+1 month, −3 days" becomes "+1 month, +3 days" rather than
   * being normalised — normalising would require a reference date.
   */
  absolute(): Duration {
    return new Duration(Math.abs(this.months), Math.abs(this.days), Math.abs(this.milliseconds));
  }

  get isZero(): boolean {
    return this.months === 0 && this.days === 0 && this.milliseconds === 0;
  }

  /** True when no bucket is positive and at least one is negative. */
  get isNegative(): boolean {
    return !this.isZero && this.months <= 0 && this.days <= 0 && this.milliseconds <= 0;
  }

  /** True when the duration has a fixed length independent of any calendar. */
  get isExact(): boolean {
    return this.months === 0;
  }

  /** True when applying this duration requires calendar-aware arithmetic. */
  get hasCalendarParts(): boolean {
    return this.months !== 0 || this.days !== 0;
  }

  private get totalMs(): number {
    if (!this.isExact) {
      throw new InvalidDurationError(
        "Cannot convert a duration containing months or years to an exact " +
          "length: a month has no fixed number of milliseconds. Apply it to a " +
          "DateTime and take the difference instead.",
      );
    }

    return this.days * MS_PER_DAY + this.milliseconds;
  }

  get totalMilliseconds(): number {
    return this.totalMs;
  }

  get totalSeconds(): number {
    return this.totalMs / MS_PER_SECOND;
  }

  get totalMinutes(): number {
    return this.totalMs / MS_PER_MINUTE;
  }

  get totalHours(): number {
    return this.totalMs / MS_PER_HOUR;
  }

  get totalDays(): number {
    return this.totalMs / MS_PER_DAY;
  }

  get totalWeeks(): number {
    return this.totalMs / MS_PER_WEEK;
  }

  equals(other: Duration): boolean {
    return (
      this.months === other.months &&
      this.days === other.days &&
      this.milliseconds === other.milliseconds
    );
  }

  toParts(): DurationParts {
    return { months: this.months, days: this.days, milliseconds: this.milliseconds };
  }

  /**
   * ISO 8601 duration notation, e.g. `P1M2DT3H30M`.
   *
   * Months are emitted as `M` in the date section and never expanded into
   * days, preserving the calendar-relative meaning through a round trip.
   */
  toISOString(): string {
    if (this.isZero) {
      return "PT0S";
    }

    const sign = this.isNegative ? "-" : "";
    const { months, days, milliseconds } = this.absolute();

    const years = Math.trunc(months / 12);
    const remainingMonths = months % 12;

    let result = sign + "P";

    if (years !== 0) {
      result += `${years}Y`;
    }

    if (remainingMonths !== 0) {
      result += `${remainingMonths}M`;
    }

    if (days !== 0) {
      result += `${days}D`;
    }

    if (milliseconds !== 0) {
      const hours = Math.trunc(milliseconds / MS_PER_HOUR);
      const minutes = Math.trunc((milliseconds % MS_PER_HOUR) / MS_PER_MINUTE);
      const seconds = (milliseconds % MS_PER_MINUTE) / MS_PER_SECOND;

      result += "T";

      if (hours !== 0) {
        result += `${hours}H`;
      }

      if (minutes !== 0) {
        result += `${minutes}M`;
      }

      if (seconds !== 0) {
        result += `${seconds}S`;
      }
    }

    return result;
  }

  toJSON(): string {
    return this.toISOString();
  }

  toString(): string {
    return this.toISOString();
  }
}
