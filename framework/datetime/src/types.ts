/**
 * Shared vocabulary types. Kept dependency-free on purpose: nothing in here
 * may reference `date-fns`, so the public API never leaks the implementation
 * library's types (plan §24, §34).
 */

// Type-only, and therefore erased: `date-time.ts` imports this module back,
// but a type-level cycle costs nothing at runtime.
import type { DateTime } from "./date-time.js";

/**
 * An IANA timezone identifier (`"Australia/Perth"`), the literal `"UTC"`, or
 * a fixed UTC offset (`"+08:00"`).
 *
 * This is intentionally `string` rather than a union of every IANA zone: the
 * zone list is host data that changes with tzdata releases, so a hardcoded
 * union would be wrong the moment a country changes its rules. Validation is
 * done at runtime instead, against the host's own database.
 */
export type TimezoneIdentifier = string;

/**
 * A BCP 47 language tag (`"en"`, `"en-AU"`, `"fr-CA"`).
 *
 * As with `TimezoneIdentifier`, this is `string` rather than a union: the set
 * of locales a host supports is platform data (`Intl`), not something this
 * package can enumerate at compile time without going stale.
 */
export type LocaleIdentifier = string;

/** Units that participate in arithmetic, boundaries, and comparisons. */
export type TimeUnit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "decade"
  | "century";

/**
 * Units whose length is fixed regardless of calendar or timezone. Arithmetic
 * on these is exact instant arithmetic and never re-resolves against a zone.
 */
export type ExactUnit = "millisecond" | "second" | "minute" | "hour";

/**
 * Units whose length depends on the calendar and the zone (a "day" is 23, 24,
 * or 25 hours across a DST transition). Arithmetic on these operates on
 * wall-clock fields and is then re-resolved against the zone.
 */
export type CalendarUnit = "day" | "week" | "month" | "quarter" | "year" | "decade" | "century";

/**
 * The units relative-time phrasing is allowed to use.
 *
 * Deliberately stops at `year` on one end and `second` on the other: nobody
 * says "3 decades ago" in a UI, and "412 milliseconds ago" is noise rather
 * than information.
 */
export type HumanUnit = "year" | "month" | "week" | "day" | "hour" | "minute" | "second";

/** `0` = Sunday through `6` = Saturday, matching `Date.prototype.getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How to resolve a wall-clock time that a timezone maps to zero or two
 * instants.
 *
 * A DST spring-forward creates a **gap**: 02:30 on the transition date simply
 * never happens in `America/New_York`. A fall-back creates an **overlap**:
 * 01:30 happens twice, once at UTC-4 and once at UTC-5.
 *
 * - `"compatible"`, the default, and what Carbon/`Temporal` do. For a gap,
 *   shift forward by the size of the gap (02:30 becomes 03:30). For an
 *   overlap, take the first (earlier) of the two instants.
 * - `"earlier"`, always prefer the earlier instant. For a gap this shifts
 *   *backwards* by the gap size (02:30 becomes 01:30).
 * - `"later"`, always prefer the later instant. Identical to `"compatible"`
 *   for gaps; takes the second occurrence for overlaps.
 * - `"reject"`, throw `AmbiguousTimeError` rather than guess. Correct for
 *   things like billing or scheduling where a silent one-hour slip is worse
 *   than a loud failure.
 */
export type Disambiguation = "compatible" | "earlier" | "later" | "reject";

/**
 * A wall-clock reading with no timezone attached, "the 20th of August 2026
 * at half past two", which is a different kind of thing from an instant.
 *
 * `month` is 1-based. Unlike `Date`, nothing here is zero-indexed; the
 * off-by-one month is the single most common date bug in JavaScript and this
 * package does not reproduce it.
 */
export interface DateTimeComponents {
  year: number;
  /** 1 (January) through 12 (December). */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** A partial wall-clock reading, for `with()`-style field replacement. */
export type PartialDateTimeComponents = Partial<DateTimeComponents>;

/** Options accepted anywhere a wall-clock time is resolved against a zone. */
export interface ResolveOptions {
  /** @default "compatible" */
  disambiguation?: Disambiguation;
}

/** Options for week-sensitive operations (`startOfWeek`, `week`, `isSameWeek`). */
export interface WeekOptions {
  /**
   * Which day the week starts on.
   *
   * Defaults to the package default (Monday, matching ISO 8601 and Carbon's
   * common configuration), not to the host locale, locale-derived week
   * starts make the same code behave differently on different machines.
   */
  weekStartsOn?: Weekday;
}

/** Options for the `diffIn*` family. */
export interface DiffOptions {
  /** Return the magnitude, discarding the sign. @default false */
  absolute?: boolean;
  /**
   * Return a fractional result instead of truncating toward zero.
   * @default false
   */
  float?: boolean;
}

/** Options for `isBetween`. */
export interface BetweenOptions {
  /** Treat the bounds as inclusive. @default true */
  inclusive?: boolean;
}

/** Options for `diffForHumans` and its aliases. */
export interface HumanizeOptions {
  /**
   * How many units to render. `1` gives `"3 days ago"`; `2` gives
   * `"3 days, 4 hours ago"`.
   *
   * Values above `1` need a locale phrase frame that this package derives
   * from `Intl` at runtime; when that derivation fails for a locale the
   * output silently falls back to a single unit rather than emitting a
   * half-translated string.
   *
   * @default 1
   */
  parts?: number;
  /**
   * `"relative"` produces `"3 days ago"` / `"in 3 days"`. `"plain"` produces
   * the bare magnitude, `"3 days"`, for callers supplying their own framing.
   *
   * @default "relative"
   */
  syntax?: "relative" | "plain";
  /** Use the locale's abbreviated forms, `"3d ago"`. @default false */
  short?: boolean;
  /** Locale tag. Defaults to the configured locale. */
  locale?: LocaleIdentifier;
  /**
   * Render differences below one `minimumUnit` as the locale's idiomatic
   * zero (`"now"`, `"il y a 3 secondes"` → `"maintenant"`) instead of
   * `"in 0 seconds"`.
   *
   * The phrase tracks `minimumUnit`, so a caller working in hours gets
   * `"this hour"` rather than a misleadingly precise `"now"`.
   *
   * @default true
   */
  justNow?: boolean;
  /**
   * The smallest unit worth naming. Differences below it collapse to "now"
   * (or to `"0 <minimumUnit>"` when `justNow` is off).
   *
   * @default "second"
   */
  minimumUnit?: HumanUnit;
  /** The largest unit worth naming. @default "year" */
  maximumUnit?: HumanUnit;
}

/**
 * Which weekdays are *not* business days, plus optional named holidays.
 *
 * Holidays are supplied as a predicate rather than a list so that a caller
 * can back them with anything, a static set, a database, a public-holiday
 * API, without this package taking a position on whose calendar is right.
 */
export interface BusinessDayOptions {
  /** @default [0, 6] (Sunday and Saturday) */
  weekend?: readonly Weekday[];
  /** Return `true` to exclude the given date from business days. */
  isHoliday?: (date: DateTime) => boolean;
}
