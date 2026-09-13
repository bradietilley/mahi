/**
 * An immutable span between two instants (plan §19).
 *
 * ## Half-open by default, and why that matters
 *
 * An `Interval` is `[start, end)`. The start is included, the end is not.
 * This is not an arbitrary preference:
 *
 * - Adjacent intervals tile without overlapping. `[09:00, 10:00)` and
 *   `[10:00, 11:00)` cover the whole two hours and share no instant, so a
 *   booking system built on them cannot double-book 10:00 sharp.
 * - Length is exactly `end - start`, with no off-by-one-millisecond
 *   correction anywhere.
 * - An empty interval is expressible (`start === end`) rather than being
 *   confused with a one-millisecond one.
 *
 * The alternative, closed intervals, forces every consumer to subtract a
 * millisecond somewhere, and that subtraction is eventually forgotten.
 * `contains` therefore excludes the end; `Interval.closed()` exists for the
 * cases where an inclusive end genuinely is what's meant, and it works by
 * extending the end by one millisecond, the same fudge, but done once, here,
 * where it is documented.
 *
 * ## Zones
 *
 * The interval's zone is its start's zone. Every `DateTime` it hands back is
 * read in that zone, so iterating an interval doesn't quietly change which
 * calendar you're on halfway through.
 */

import { DateTime, type DateTimeLike } from "./date-time.js";
import { Duration, type DurationInput } from "./duration.js";
import { InvalidIntervalError } from "./errors.js";
import type { TimezoneIdentifier } from "./types.js";

export class Interval {
  private constructor(
    readonly start: DateTime,
    readonly end: DateTime,
  ) {
    Object.freeze(this);
  }

  /**
   * The half-open interval `[start, end)`.
   *
   * Throws if `end` precedes `start`: a negative-length interval has no
   * coherent meaning, and accepting one only defers the error to whichever
   * `contains` call first behaves absurdly.
   */
  static between(start: DateTimeLike, end: DateTimeLike): Interval {
    const from = DateTime.parse(start);
    const to = DateTime.parse(end).inTimezone(from.timezone);

    if (to.isBefore(from)) {
      throw new InvalidIntervalError(
        `An interval cannot end before it starts: ${from.toISOString()} → ${to.toISOString()}. ` +
          `Use Interval.around() if the order of the two bounds is not known.`,
      );
    }

    return new Interval(from, to);
  }

  /** As `between`, but accepting the bounds in either order. */
  static around(a: DateTimeLike, b: DateTimeLike): Interval {
    const first = DateTime.parse(a);
    const second = DateTime.parse(b);

    return second.isBefore(first)
      ? Interval.between(second, first)
      : Interval.between(first, second);
  }

  /**
   * The closed interval `[start, end]`, stored as `[start, end + 1ms)`.
   *
   * The inclusive end is converted immediately so that only one
   * representation exists internally. `endInclusive` reads it back.
   */
  static closed(start: DateTimeLike, end: DateTimeLike): Interval {
    return Interval.between(start, DateTime.parse(end).addMilliseconds(1));
  }

  /** `[start, start + duration)`. A negative duration is rejected by `between`. */
  static fromDuration(start: DateTimeLike, duration: Duration | DurationInput): Interval {
    const from = DateTime.parse(start);

    return Interval.between(from, from.add(duration));
  }

  /** `[end - duration, end)`. */
  static endingAt(end: DateTimeLike, duration: Duration | DurationInput): Interval {
    const to = DateTime.parse(end);

    return Interval.between(to.subtract(duration), to);
  }

  /** The zero-length interval at `instant`. Contains nothing, not even `instant`. */
  static empty(instant: DateTimeLike): Interval {
    const at = DateTime.parse(instant);

    return new Interval(at, at);
  }

  /** The last instant actually inside the interval. Throws when empty. */
  get endInclusive(): DateTime {
    if (this.isEmpty) {
      throw new InvalidIntervalError("An empty interval has no inclusive end.");
    }

    return this.end.subMilliseconds(1);
  }

  /** The zone every `DateTime` produced by this interval is read in. */
  get timezone(): TimezoneIdentifier {
    return this.start.timezone;
  }

  /** Exact elapsed length. Always non-negative, never calendar-relative. */
  get duration(): Duration {
    return Duration.milliseconds(this.lengthMs);
  }

  get lengthMs(): number {
    return this.end.epochMilliseconds - this.start.epochMilliseconds;
  }

  get isEmpty(): boolean {
    return this.lengthMs === 0;
  }

  /** Read this interval's bounds in another zone. The instants are unchanged. */
  inTimezone(zone: TimezoneIdentifier): Interval {
    return new Interval(this.start.inTimezone(zone), this.end.inTimezone(zone));
  }

  /** Whether `instant` is in `[start, end)`. An empty interval contains nothing. */
  contains(instant: DateTimeLike): boolean {
    const value = DateTime.parse(instant).epochMilliseconds;

    return value >= this.start.epochMilliseconds && value < this.end.epochMilliseconds;
  }

  /** Whether `other` lies wholly within this interval. */
  encloses(other: Interval): boolean {
    if (other.isEmpty) {
      return this.contains(other.start);
    }

    return (
      other.start.epochMilliseconds >= this.start.epochMilliseconds &&
      other.end.epochMilliseconds <= this.end.epochMilliseconds
    );
  }

  /**
   * Whether the two share at least one instant.
   *
   * Touching intervals do *not* overlap: `[09:00, 10:00)` and
   * `[10:00, 11:00)` are adjacent, and treating them as overlapping is the
   * bug half-open intervals exist to prevent.
   */
  overlaps(other: Interval): boolean {
    if (this.isEmpty || other.isEmpty) {
      return false;
    }

    return (
      this.start.epochMilliseconds < other.end.epochMilliseconds &&
      other.start.epochMilliseconds < this.end.epochMilliseconds
    );
  }

  /** Whether one interval begins exactly where the other ends. */
  isAdjacent(other: Interval): boolean {
    return this.end.isEqual(other.start) || other.end.isEqual(this.start);
  }

  /** Whether this interval ends at or before `other` begins. */
  isBefore(other: Interval): boolean {
    return this.end.epochMilliseconds <= other.start.epochMilliseconds;
  }

  isAfter(other: Interval): boolean {
    return other.isBefore(this);
  }

  /** Whether the two describe the same instants. */
  equals(other: Interval): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  /** The shared span, or `null` when the two do not overlap. */
  intersection(other: Interval): Interval | null {
    if (!this.overlaps(other)) {
      return null;
    }

    return new Interval(
      DateTime.max(this.start, other.start).inTimezone(this.timezone),
      DateTime.min(this.end, other.end).inTimezone(this.timezone),
    );
  }

  /**
   * The single interval covering both, or `null` when that would require
   * inventing coverage.
   *
   * Adjacent intervals unite; disjoint ones do not. Returning the enclosing
   * span for `[09:00, 10:00)` and `[14:00, 15:00)` would silently claim the
   * four hours in between, so the gap is reported instead.
   */
  union(other: Interval): Interval | null {
    if (!this.overlaps(other) && !this.isAdjacent(other)) {
      return null;
    }

    return new Interval(
      DateTime.min(this.start, other.start).inTimezone(this.timezone),
      DateTime.max(this.end, other.end).inTimezone(this.timezone),
    );
  }

  /**
   * What remains of this interval once `other` is removed.
   *
   * Returns zero, one, or two intervals: punching a hole in the middle of a
   * span leaves two pieces, and pretending otherwise would lose one of them.
   */
  difference(other: Interval): Interval[] {
    if (!this.overlaps(other)) {
      return this.isEmpty ? [] : [this];
    }

    const pieces: Interval[] = [];

    if (this.start.isBefore(other.start)) {
      pieces.push(new Interval(this.start, other.start.inTimezone(this.timezone)));
    }

    if (other.end.isBefore(this.end)) {
      pieces.push(new Interval(other.end.inTimezone(this.timezone), this.end));
    }

    return pieces;
  }

  /** The gap between two disjoint intervals, or `null` if they meet or overlap. */
  gap(other: Interval): Interval | null {
    if (this.overlaps(other) || this.isAdjacent(other)) {
      return null;
    }

    return this.isBefore(other)
      ? new Interval(this.end, other.start.inTimezone(this.timezone))
      : new Interval(other.end.inTimezone(this.timezone), this.start);
  }

  /** Move both bounds by the same duration, preserving the length. */
  shift(duration: Duration | DurationInput): Interval {
    return new Interval(this.start.add(duration), this.end.add(duration));
  }

  /** Grow at both ends. Use a negative duration to shrink. */
  expand(duration: Duration | DurationInput): Interval {
    const amount = Duration.from(duration);

    return Interval.between(this.start.subtract(amount), this.end.add(amount));
  }

  withStart(start: DateTimeLike): Interval {
    return Interval.between(start, this.end);
  }

  withEnd(end: DateTimeLike): Interval {
    return Interval.between(this.start, end);
  }

  /**
   * Cut the interval at each of the given instants.
   *
   * Instants outside the interval are ignored, and the pieces are returned in
   * order, tiling the original exactly.
   */
  splitAt(...instants: DateTimeLike[]): Interval[] {
    const cuts = instants
      .map((instant) => DateTime.parse(instant))
      .filter((instant) => this.contains(instant) && !instant.isEqual(this.start))
      .map((instant) => instant.epochMilliseconds)
      .sort((a, b) => a - b);

    const pieces: Interval[] = [];
    let cursor = this.start;

    for (const cut of cuts) {
      const at = DateTime.fromTimestamp(cut, this.timezone);

      if (at.isEqual(cursor)) {
        continue;
      }

      pieces.push(new Interval(cursor, at));
      cursor = at;
    }

    if (!cursor.isEqual(this.end) || pieces.length === 0) {
      pieces.push(new Interval(cursor, this.end));
    }

    return pieces;
  }

  /** ISO 8601 interval notation, `<start>/<end>`. */
  toISOString(): string {
    return `${this.start.toISOString()}/${this.end.toISOString()}`;
  }

  toJSON(): string {
    return this.toISOString();
  }

  toString(): string {
    return this.toISOString();
  }

  /** Parse ISO 8601 `<start>/<end>` notation. */
  static fromISOString(input: string, zone?: TimezoneIdentifier): Interval {
    const separator = input.indexOf("/");

    if (separator === -1) {
      throw new InvalidIntervalError(
        `"${input}" is not an ISO 8601 interval. Expected "<start>/<end>".`,
      );
    }

    return Interval.between(
      DateTime.parse(input.slice(0, separator), zone),
      DateTime.parse(input.slice(separator + 1), zone),
    );
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Interval(${this.start.toISOString()} → ${this.end.toISOString()})`;
  }
}
