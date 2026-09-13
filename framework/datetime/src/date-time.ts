/**
 * An immutable moment in time, together with the timezone it should be read
 * in.
 *
 * ## The temporal model (plan §2)
 *
 * A `DateTime` is **an absolute instant plus a display zone**. The instant is
 * a count of milliseconds since the Unix epoch; the zone is an IANA
 * identifier retained alongside it. Two `DateTime`s at the same instant in
 * different zones are *equal as instants* (`isEqual` is true) but have
 * different wall-clock readings (`year`, `hour`, and friends differ).
 *
 * That single decision explains most of the API:
 *
 * - `inTimezone(zone)` changes how an instant is *read*. The instant is
 *   untouched, so `isEqual` still holds.
 * - `keepLocalTime(zone)` changes *which instant* is meant, preserving the
 *   wall clock. 09:00 in Perth becomes 09:00 in Sydney, a different moment.
 *   These two are the operations that §11 insists on distinguishing, and
 *   conflating them is the classic timezone bug.
 * - Exact arithmetic (`addHours` and below) moves the instant. Calendar
 *   arithmetic (`addDays` and above) moves the *wall clock* and then
 *   re-resolves against the zone. So across a US spring-forward,
 *   `addDays(1)` advances 23 real hours while `addHours(24)` advances 24,
 *   both correct, answering different questions.
 * - A wall clock that a zone maps to zero or two instants is resolved by an
 *   explicit `Disambiguation` policy rather than by luck.
 *
 * Precision is milliseconds. Date-only values are represented as an instant
 * at the start of the day in a zone (`startOfDay`); there is no separate
 * date-only type in this phase.
 *
 * ## Immutability
 *
 * Every instance is frozen and every operation returns a new one. Nothing on
 * this class mutates.
 */

import {
  addCivilDays,
  addCivilMonths,
  addCivilQuarters,
  addCivilWeeks,
  addCivilYears,
  civilDaysInMonth,
  civilDaysInYear,
  civilISOWeek,
  civilISOWeekYear,
  civilWeek,
  civilWeekYear,
} from "./internal/adapters/arithmetic-adapter.js";
import {
  formatInstant,
  ISO_DATE_PATTERN,
  ISO_PATTERN,
  ISO_TIME_PATTERN,
  RFC2822_PATTERN,
  RFC3339_PATTERN,
} from "./internal/adapters/formatting-adapter.js";
import { parseFormat, parseISO } from "./internal/adapters/parsing-adapter.js";
import {
  assertValidTimezone,
  componentsFromInstant,
  civilMsFromInstant,
  instantFromCivilMs,
  instantFromComponents,
  offsetFor,
} from "./internal/adapters/timezone-adapter.js";
import {
  civilDayOfYear,
  civilWeekday,
  componentsAreInRange,
  encodeCivil,
  isLeapYear,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MS_PER_WEEK,
} from "./internal/civil.js";
import { decompose, renderParts } from "./internal/humanize.js";
import { getDefaultLocale, getDefaultTimezone, getDefaultWeekStartsOn } from "./config.js";
import { Duration, type DurationInput } from "./duration.js";
import { InvalidDateTimeError, InvalidFormatError } from "./errors.js";
import { Locale, type NameStyle } from "./locale.js";
import type {
  BetweenOptions,
  BusinessDayOptions,
  DateTimeComponents,
  DiffOptions,
  Disambiguation,
  HumanizeOptions,
  HumanUnit,
  LocaleIdentifier,
  PartialDateTimeComponents,
  ResolveOptions,
  TimeUnit,
  TimezoneIdentifier,
  Weekday,
  WeekOptions,
} from "./types.js";

/** Anything that can stand in for a `DateTime` in a comparison. */
export type DateTimeLike = DateTime | Date | number | string;

const EXACT_UNIT_MS: Record<string, number> = {
  millisecond: 1,
  second: MS_PER_SECOND,
  minute: MS_PER_MINUTE,
  hour: MS_PER_HOUR,
};

/**
 * Derived wall-clock values are memoised here rather than in instance fields,
 * because instances are `Object.freeze`d and a frozen object cannot hold a
 * lazily-populated cache. Keying a `WeakMap` on the instance keeps both
 * properties: genuinely immutable objects, and no repeated `Intl` lookups for
 * the same instant. Entries die with their `DateTime`.
 */
const civilMsCache = new WeakMap<DateTime, number>();
const componentsCache = new WeakMap<DateTime, DateTimeComponents>();

export class DateTime {
  /**
   * Frozen clock for tests, in the spirit of Carbon's `setTestNow()`.
   * Everything that reads the current time goes through `nowInstant()`, so
   * freezing here freezes `now`, `today`, `isPast`, `diffForHumans`, and so
   * on together, a clock that only half-freezes is worse than none.
   */
  private static testNow: DateTime | null = null;

  private constructor(
    readonly epochMilliseconds: number,
    readonly timezone: TimezoneIdentifier,
  ) {
    // TypeScript's `private` is erased at runtime, so plain JavaScript can
    // still reach this constructor. The package's central claim is that a
    // `DateTime` is *always* a valid instant, and a claim that only holds for
    // TypeScript callers is not much of a claim. The check costs a couple of
    // nanoseconds against the `Object.freeze` on the next line.
    if (!Number.isFinite(epochMilliseconds)) {
      throw new InvalidDateTimeError(
        `A DateTime must be built from a finite instant, got ${String(epochMilliseconds)}. ` +
          `Use DateTime.fromTimestamp(), DateTime.parse(), or one of the other factories.`,
      );
    }

    Object.freeze(this);
  }

  /** The current instant, read in `zone` (default: the configured zone). */
  static now(zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromTimestamp(DateTime.nowInstant(), zone);
  }

  /** Midnight at the start of the current day in `zone`. */
  static today(zone?: TimezoneIdentifier): DateTime {
    return DateTime.now(zone).startOfDay();
  }

  static yesterday(zone?: TimezoneIdentifier): DateTime {
    return DateTime.today(zone).subDays(1);
  }

  static tomorrow(zone?: TimezoneIdentifier): DateTime {
    return DateTime.today(zone).addDays(1);
  }

  /**
   * Build from wall-clock components interpreted in `zone`.
   *
   * Strict: out-of-range components throw rather than rolling over, so
   * `create(2026, 2, 30)` is an error instead of 2 March. Use `createSafe`
   * for untrusted input, or `DateTime.fromComponents` with an explicit
   * disambiguation policy for DST-sensitive work.
   */
  static create(
    year: number,
    month = 1,
    day = 1,
    hour = 0,
    minute = 0,
    second = 0,
    millisecond = 0,
    zone?: TimezoneIdentifier,
  ): DateTime {
    return DateTime.fromComponents({ year, month, day, hour, minute, second, millisecond }, zone);
  }

  /** As `create`, but returns `null` instead of throwing on bad components. */
  static createSafe(
    year: number,
    month = 1,
    day = 1,
    hour = 0,
    minute = 0,
    second = 0,
    millisecond = 0,
    zone?: TimezoneIdentifier,
  ): DateTime | null {
    try {
      return DateTime.create(year, month, day, hour, minute, second, millisecond, zone);
    } catch {
      return null;
    }
  }

  /** Midnight in `zone` on the given calendar date. */
  static createMidnightDate(
    year: number,
    month: number,
    day: number,
    zone?: TimezoneIdentifier,
  ): DateTime {
    return DateTime.create(year, month, day, 0, 0, 0, 0, zone);
  }

  /**
   * The given calendar date, at the **current time of day**.
   *
   * This is Carbon's `createFromDate()` semantics, and they surprise people:
   * the result is not midnight. It is retained for migration fidelity, but
   * `createMidnightDate()` is almost always what you actually want, and it
   * says so in its name.
   */
  static createFromDate(
    year: number,
    month: number,
    day: number,
    zone?: TimezoneIdentifier,
  ): DateTime {
    return DateTime.now(zone).with({ year, month, day });
  }

  /** Today's date in `zone`, at the given time of day. */
  static createFromTime(
    hour: number,
    minute = 0,
    second = 0,
    millisecond = 0,
    zone?: TimezoneIdentifier,
  ): DateTime {
    return DateTime.now(zone).with({ hour, minute, second, millisecond });
  }

  /** Carbon's spelling of `fromUnixTimestamp()`, seconds since the epoch. */
  static createFromTimestamp(seconds: number, zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromUnixTimestamp(seconds, zone);
  }

  /** Carbon's spelling of `fromTimestamp()`, milliseconds since the epoch. */
  static createFromTimestampMs(milliseconds: number, zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromTimestamp(milliseconds, zone);
  }

  /** Carbon's spelling of `fromDate()`, for adopting a native `Date`. */
  static instance(date: Date, zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromDate(date, zone);
  }

  static fromComponents(
    components: DateTimeComponents,
    zone?: TimezoneIdentifier,
    options: ResolveOptions = {},
  ): DateTime {
    if (!componentsAreInRange(components)) {
      throw new InvalidDateTimeError(
        `Invalid date components: ${JSON.stringify(components)}. ` +
          `Months are 1-12 and days must exist in the given month.`,
      );
    }

    const resolved = DateTime.resolveZone(zone);

    return new DateTime(
      instantFromComponents(resolved, components, options.disambiguation),
      resolved,
    );
  }

  /** Adopts the instant of a native `Date`; the `Date` itself is not retained. */
  static fromDate(date: Date, zone?: TimezoneIdentifier): DateTime {
    const instant = date.getTime();

    if (Number.isNaN(instant)) {
      throw new InvalidDateTimeError("Cannot build a DateTime from an Invalid Date.");
    }

    return DateTime.fromTimestamp(instant, zone);
  }

  /** From milliseconds since the Unix epoch. */
  static fromTimestamp(milliseconds: number, zone?: TimezoneIdentifier): DateTime {
    if (!Number.isFinite(milliseconds)) {
      throw new InvalidDateTimeError(`Timestamp must be a finite number, got ${milliseconds}.`);
    }

    return new DateTime(milliseconds, DateTime.resolveZone(zone));
  }

  /** From whole (or fractional) seconds since the Unix epoch. */
  static fromUnixTimestamp(seconds: number, zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromTimestamp(seconds * MS_PER_SECOND, zone);
  }

  /**
   * Parse ISO 8601 / RFC 3339, or the space-separated database variant.
   *
   * If the string carries its own offset (`…T14:30+08:00`, `…T06:30Z`) that
   * offset determines the instant, and `zone` only decides how the result is
   * displayed. If it does not, the wall clock is interpreted *in* `zone`.
   * This is the distinction that makes `parse("2026-08-20 14:30",
   * "Australia/Perth")` mean what a reader expects.
   */
  static fromISO(input: string, zone?: TimezoneIdentifier, options: ResolveOptions = {}): DateTime {
    const parsed = parseISO(input);

    if (parsed === null) {
      throw new InvalidFormatError(
        `"${input}" is not a valid ISO 8601 date/time. Expected something ` +
          `like "2026-08-20", "2026-08-20T14:30:00Z", or "2026-08-20 14:30:00".`,
      );
    }

    const resolved = DateTime.resolveZone(zone);

    if (parsed.offsetMs !== null) {
      return new DateTime(encodeCivil(parsed.components) - parsed.offsetMs, resolved);
    }

    return DateTime.fromComponents(parsed.components, resolved, options);
  }

  /** Alias of `fromISO`; RFC 3339 is a profile of ISO 8601. */
  static fromRFC3339(input: string, zone?: TimezoneIdentifier): DateTime {
    return DateTime.fromISO(input, zone);
  }

  /**
   * The general-purpose entry point, accepting anything `DateTime` knows how
   * to interpret.
   *
   * Only unambiguous formats are accepted. There is no attempt to guess
   * whether `"03/04/2026"` is March or April: locale-guessing parsers are a
   * reliable source of production incidents, and `createFromFormat` exists
   * for when the caller genuinely knows the layout.
   */
  static parse(
    input: DateTimeLike,
    zone?: TimezoneIdentifier,
    options: ResolveOptions = {},
  ): DateTime {
    if (input instanceof DateTime) {
      return zone === undefined ? input : input.inTimezone(zone);
    }

    if (input instanceof Date) {
      return DateTime.fromDate(input, zone);
    }

    if (typeof input === "number") {
      return DateTime.fromTimestamp(input, zone);
    }

    return DateTime.fromISO(input, zone, options);
  }

  /** As `parse`, but returns `null` instead of throwing. */
  static parseSafe(input: DateTimeLike, zone?: TimezoneIdentifier): DateTime | null {
    try {
      return DateTime.parse(input, zone);
    } catch {
      return null;
    }
  }

  /**
   * Parse against an explicit `date-fns` pattern (`"dd/MM/yyyy HH:mm"`).
   *
   * Strict by default: the parsed result must re-format to exactly the input,
   * which rejects `"2026-02-31"` and other inputs a lenient parser would
   * quietly correct. Pass `strict: false` to allow that leniency.
   *
   * Fields the pattern does not mention default to the current date in
   * `zone` at midnight, so `createFromFormat("14:30", "HH:mm")` means half
   * past two *today*.
   */
  static createFromFormat(
    input: string,
    pattern: string,
    zone?: TimezoneIdentifier,
    options: ResolveOptions & { strict?: boolean } = {},
  ): DateTime {
    const resolved = DateTime.resolveZone(zone);
    const reference = DateTime.now(resolved).startOfDay().civilMs;

    const components = parseFormat(input, pattern, reference, options.strict !== false);

    if (components === null) {
      throw new InvalidFormatError(`"${input}" does not match the format "${pattern}".`);
    }

    return DateTime.fromComponents(components, resolved, options);
  }

  /**
   * Freeze the clock. Pass `null` to unfreeze.
   *
   * Intended for tests and for the framework's own time-travel helpers; do
   * not call it from application code.
   */
  static setTestNow(instant: DateTimeLike | null): void {
    DateTime.testNow = instant === null ? null : DateTime.parse(instant);
  }

  static hasTestNow(): boolean {
    return DateTime.testNow !== null;
  }

  private static nowInstant(): number {
    return DateTime.testNow?.epochMilliseconds ?? Date.now();
  }

  private static resolveZone(zone?: TimezoneIdentifier): TimezoneIdentifier {
    return zone === undefined ? getDefaultTimezone() : assertValidTimezone(zone);
  }

  /** This instant's wall clock in this zone, encoded as civil milliseconds. */
  private get civilMs(): number {
    let cached = civilMsCache.get(this);

    if (cached === undefined) {
      cached = civilMsFromInstant(this.timezone, this.epochMilliseconds);
      civilMsCache.set(this, cached);
    }

    return cached;
  }

  private get components(): DateTimeComponents {
    let cached = componentsCache.get(this);

    if (cached === undefined) {
      cached = componentsFromInstant(this.timezone, this.epochMilliseconds);
      componentsCache.set(this, cached);
    }

    return cached;
  }

  /**
   * Re-resolve a modified wall clock against this zone.
   *
   * Every calendar operation funnels through here, which is what makes DST
   * handling uniform: there is exactly one place where a wall clock becomes
   * an instant.
   */
  private withCivilMs(civilMs: number, disambiguation: Disambiguation = "compatible"): DateTime {
    return new DateTime(instantFromCivilMs(this.timezone, civilMs, disambiguation), this.timezone);
  }

  private withInstant(instant: number): DateTime {
    return new DateTime(instant, this.timezone);
  }

  get year(): number {
    return this.components.year;
  }

  /** 1 (January) through 12 (December), not zero-indexed. */
  get month(): number {
    return this.components.month;
  }

  get day(): number {
    return this.components.day;
  }

  /** Alias of `day`, for readers coming from Carbon's `->dayOfMonth`. */
  get dayOfMonth(): number {
    return this.components.day;
  }

  get hour(): number {
    return this.components.hour;
  }

  get minute(): number {
    return this.components.minute;
  }

  get second(): number {
    return this.components.second;
  }

  get millisecond(): number {
    return this.components.millisecond;
  }

  /** `0` = Sunday … `6` = Saturday. */
  get dayOfWeek(): Weekday {
    return civilWeekday(this.civilMs) as Weekday;
  }

  /** `1` = Monday … `7` = Sunday. */
  get isoDayOfWeek(): number {
    return this.dayOfWeek === 0 ? 7 : this.dayOfWeek;
  }

  get dayOfYear(): number {
    return civilDayOfYear(this.civilMs);
  }

  get quarter(): number {
    return Math.floor((this.month - 1) / 3) + 1;
  }

  get daysInMonth(): number {
    return civilDaysInMonth(this.civilMs);
  }

  get daysInYear(): number {
    return civilDaysInYear(this.civilMs);
  }

  /** Milliseconds since the Unix epoch. */
  get timestamp(): number {
    return this.epochMilliseconds;
  }

  /** Whole seconds since the Unix epoch, floored (matching `date +%s`). */
  get unixTimestamp(): number {
    return Math.floor(this.epochMilliseconds / MS_PER_SECOND);
  }

  /** Milliseconds to add to UTC to reach this zone's wall clock. */
  get offset(): number {
    return offsetFor(this.timezone, this.epochMilliseconds);
  }

  get offsetMinutes(): number {
    return this.offset / MS_PER_MINUTE;
  }

  get offsetHours(): number {
    return this.offset / MS_PER_HOUR;
  }

  /** The IANA identifier, e.g. `"Australia/Perth"`. */
  get timezoneName(): TimezoneIdentifier {
    return this.timezone;
  }

  week(options: WeekOptions = {}): number {
    return civilWeek(this.civilMs, options.weekStartsOn ?? getDefaultWeekStartsOn());
  }

  weekYear(options: WeekOptions = {}): number {
    return civilWeekYear(this.civilMs, options.weekStartsOn ?? getDefaultWeekStartsOn());
  }

  get isoWeek(): number {
    return civilISOWeek(this.civilMs);
  }

  get isoWeekYear(): number {
    return civilISOWeekYear(this.civilMs);
  }

  /**
   * Replace individual wall-clock fields, leaving the rest alone.
   *
   * The result is re-resolved against the zone, so replacing the hour on a
   * DST transition date behaves the same as any other calendar operation.
   */
  with(components: PartialDateTimeComponents, options: ResolveOptions = {}): DateTime {
    const next = { ...this.components, ...components };

    if (!componentsAreInRange(next)) {
      throw new InvalidDateTimeError(
        `Invalid date components after with(): ${JSON.stringify(next)}.`,
      );
    }

    return this.withCivilMs(encodeCivil(next), options.disambiguation);
  }

  withYear(year: number): DateTime {
    return this.with({ year });
  }

  withMonth(month: number): DateTime {
    return this.with({ month });
  }

  withDay(day: number): DateTime {
    return this.with({ day });
  }

  withHour(hour: number): DateTime {
    return this.with({ hour });
  }

  withMinute(minute: number): DateTime {
    return this.with({ minute });
  }

  withSecond(second: number): DateTime {
    return this.with({ second });
  }

  withMillisecond(millisecond: number): DateTime {
    return this.with({ millisecond });
  }

  /**
   * Add a `Duration`.
   *
   * Buckets are applied largest-first (months, then days, then exact time),
   * which matters at month boundaries: 31 January plus "1 month and 1 day"
   * is 1 March (clamp to 28 Feb, then add a day), not 3 March. Applying them
   * in the other order would give a different answer, so the order is fixed
   * and tested rather than incidental.
   */
  add(duration: Duration | DurationInput): DateTime {
    const { months, days, milliseconds } = Duration.from(duration);

    const afterMonths = months === 0 ? this : this.addMonths(months);
    const afterDays = days === 0 ? afterMonths : afterMonths.addDays(days);

    return milliseconds === 0
      ? afterDays
      : afterDays.withInstant(afterDays.epochMilliseconds + milliseconds);
  }

  subtract(duration: Duration | DurationInput): DateTime {
    return this.add(Duration.from(duration).negate());
  }

  addMilliseconds(amount: number): DateTime {
    return this.withInstant(this.epochMilliseconds + amount);
  }

  addSeconds(amount: number): DateTime {
    return this.addMilliseconds(amount * MS_PER_SECOND);
  }

  addMinutes(amount: number): DateTime {
    return this.addMilliseconds(amount * MS_PER_MINUTE);
  }

  addHours(amount: number): DateTime {
    return this.addMilliseconds(amount * MS_PER_HOUR);
  }

  /** Advances the wall clock by whole days, preserving the local time-of-day. */
  addDays(amount: number): DateTime {
    return this.withCivilMs(addCivilDays(this.civilMs, amount));
  }

  addWeeks(amount: number): DateTime {
    return this.withCivilMs(addCivilWeeks(this.civilMs, amount));
  }

  /** Clamps the day-of-month: 31 Jan + 1 month is 28/29 Feb. */
  addMonths(amount: number): DateTime {
    return this.withCivilMs(addCivilMonths(this.civilMs, amount));
  }

  addQuarters(amount: number): DateTime {
    return this.withCivilMs(addCivilQuarters(this.civilMs, amount));
  }

  /** Clamps 29 February to 28 February in common years. */
  addYears(amount: number): DateTime {
    return this.withCivilMs(addCivilYears(this.civilMs, amount));
  }

  subMilliseconds(amount: number): DateTime {
    return this.addMilliseconds(-amount);
  }

  subSeconds(amount: number): DateTime {
    return this.addSeconds(-amount);
  }

  subMinutes(amount: number): DateTime {
    return this.addMinutes(-amount);
  }

  subHours(amount: number): DateTime {
    return this.addHours(-amount);
  }

  subDays(amount: number): DateTime {
    return this.addDays(-amount);
  }

  subWeeks(amount: number): DateTime {
    return this.addWeeks(-amount);
  }

  subMonths(amount: number): DateTime {
    return this.addMonths(-amount);
  }

  subQuarters(amount: number): DateTime {
    return this.addQuarters(-amount);
  }

  subYears(amount: number): DateTime {
    return this.addYears(-amount);
  }

  /**
   * Truncate the wall clock to the start of `unit`.
   *
   * Uses the `"compatible"` policy, which is the only one that keeps the
   * result inside the unit: an ambiguous start-of-day takes the *earlier* of
   * the two occurrences, while a start-of-day that lands in a DST gap (São
   * Paulo used to move its clocks at midnight, so 2018-11-04 had no 00:00)
   * shifts *forward* to the first instant that does exist. The `"earlier"`
   * policy would shift backwards into the previous day, which is not a
   * defensible "start of day".
   */
  startOf(unit: TimeUnit, options: WeekOptions = {}): DateTime {
    return this.withCivilMs(this.truncatedCivilMs(unit, options), "compatible");
  }

  /**
   * The last representable millisecond within `unit`.
   *
   * Resolved to the *later* instant when ambiguous, so that an end-of-day
   * during a fall-back really is the end of that day rather than an hour
   * short of it.
   */
  endOf(unit: TimeUnit, options: WeekOptions = {}): DateTime {
    return this.withCivilMs(this.endCivilMs(unit, options), "later");
  }

  private truncatedCivilMs(unit: TimeUnit, options: WeekOptions): number {
    const c = this.components;

    switch (unit) {
      case "millisecond":
        return this.civilMs;
      case "second":
        return encodeCivil({ ...c, millisecond: 0 });
      case "minute":
        return encodeCivil({ ...c, second: 0, millisecond: 0 });
      case "hour":
        return encodeCivil({ ...c, minute: 0, second: 0, millisecond: 0 });
      case "day":
        return encodeCivil({ ...c, hour: 0, minute: 0, second: 0, millisecond: 0 });
      case "week": {
        const weekStartsOn = options.weekStartsOn ?? getDefaultWeekStartsOn();
        const back = (civilWeekday(this.civilMs) - weekStartsOn + 7) % 7;
        const startOfDay = encodeCivil({
          ...c,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        });

        return addCivilDays(startOfDay, -back);
      }
      case "month":
        return encodeCivil({ ...c, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
      case "quarter":
        return encodeCivil({
          ...c,
          month: (this.quarter - 1) * 3 + 1,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        });
      case "year":
      case "decade":
      case "century":
        return encodeCivil({
          ...c,
          year: startYearOf(c.year, unit),
          month: 1,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        });
    }
  }

  private endCivilMs(unit: TimeUnit, options: WeekOptions): number {
    const start = this.truncatedCivilMs(unit, options);

    // The end of a unit is one millisecond before the start of the next.
    // Doing this in civil space keeps it correct across DST, because the
    // civil timeline has no gaps or overlaps by construction.
    switch (unit) {
      case "millisecond":
        return start;
      case "second":
        return start + MS_PER_SECOND - 1;
      case "minute":
        return start + MS_PER_MINUTE - 1;
      case "hour":
        return start + MS_PER_HOUR - 1;
      case "day":
        return start + MS_PER_DAY - 1;
      case "week":
        return start + MS_PER_WEEK - 1;
      case "month":
        return addCivilMonths(start, 1) - 1;
      case "quarter":
        return addCivilQuarters(start, 1) - 1;
      case "year":
        return addCivilYears(start, 1) - 1;
      case "decade":
        return addCivilYears(start, 10) - 1;
      case "century":
        return addCivilYears(start, 100) - 1;
    }
  }

  startOfMillisecond(): DateTime {
    return this.startOf("millisecond");
  }

  endOfMillisecond(): DateTime {
    return this.endOf("millisecond");
  }

  startOfSecond(): DateTime {
    return this.startOf("second");
  }

  endOfSecond(): DateTime {
    return this.endOf("second");
  }

  startOfMinute(): DateTime {
    return this.startOf("minute");
  }

  endOfMinute(): DateTime {
    return this.endOf("minute");
  }

  startOfHour(): DateTime {
    return this.startOf("hour");
  }

  endOfHour(): DateTime {
    return this.endOf("hour");
  }

  startOfDay(): DateTime {
    return this.startOf("day");
  }

  endOfDay(): DateTime {
    return this.endOf("day");
  }

  startOfWeek(options: WeekOptions = {}): DateTime {
    return this.startOf("week", options);
  }

  endOfWeek(options: WeekOptions = {}): DateTime {
    return this.endOf("week", options);
  }

  startOfMonth(): DateTime {
    return this.startOf("month");
  }

  endOfMonth(): DateTime {
    return this.endOf("month");
  }

  startOfQuarter(): DateTime {
    return this.startOf("quarter");
  }

  endOfQuarter(): DateTime {
    return this.endOf("quarter");
  }

  startOfYear(): DateTime {
    return this.startOf("year");
  }

  endOfYear(): DateTime {
    return this.endOf("year");
  }

  /**
   * `-1`, `0`, or `1`, comparing **instants**. Zones are irrelevant here:
   * 09:00 Perth and 11:00 Sydney on the same day are the same moment and
   * compare equal.
   */
  compareTo(other: DateTimeLike): -1 | 0 | 1 {
    const theirs = DateTime.parse(other).epochMilliseconds;

    if (this.epochMilliseconds < theirs) {
      return -1;
    }

    if (this.epochMilliseconds > theirs) {
      return 1;
    }

    return 0;
  }

  isBefore(other: DateTimeLike): boolean {
    return this.compareTo(other) < 0;
  }

  isAfter(other: DateTimeLike): boolean {
    return this.compareTo(other) > 0;
  }

  isBeforeOrEqual(other: DateTimeLike): boolean {
    return this.compareTo(other) <= 0;
  }

  isAfterOrEqual(other: DateTimeLike): boolean {
    return this.compareTo(other) >= 0;
  }

  /** Same instant. Does **not** require the same zone. */
  isEqual(other: DateTimeLike): boolean {
    return this.compareTo(other) === 0;
  }

  /** Same instant *and* same zone, structural identity, not just equality. */
  isIdentical(other: DateTime): boolean {
    return this.isEqual(other) && this.timezone === other.timezone;
  }

  /**
   * Whether both fall in the same calendar `unit`.
   *
   * Calendar comparisons are made in **this** instance's zone: "same day" is
   * a question about a calendar, and a calendar requires a zone. Comparing a
   * Perth `DateTime` with a New York one asks whether the New York instant
   * lands on the same Perth day.
   */
  isSame(unit: TimeUnit, other: DateTimeLike, options: WeekOptions = {}): boolean {
    const theirs = this.coerceToThisZone(other);

    return (
      this.startOf(unit, options).epochMilliseconds ===
      theirs.startOf(unit, options).epochMilliseconds
    );
  }

  isSameDay(other: DateTimeLike): boolean {
    return this.isSame("day", other);
  }

  isSameWeek(other: DateTimeLike, options: WeekOptions = {}): boolean {
    return this.isSame("week", other, options);
  }

  isSameMonth(other: DateTimeLike): boolean {
    return this.isSame("month", other);
  }

  isSameQuarter(other: DateTimeLike): boolean {
    return this.isSame("quarter", other);
  }

  isSameYear(other: DateTimeLike): boolean {
    return this.isSame("year", other);
  }

  /** Bounds may be given in either order; inclusive by default. */
  isBetween(start: DateTimeLike, end: DateTimeLike, options: BetweenOptions = {}): boolean {
    const a = DateTime.parse(start).epochMilliseconds;
    const b = DateTime.parse(end).epochMilliseconds;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const value = this.epochMilliseconds;

    return options.inclusive === false
      ? value > low && value < high
      : value >= low && value <= high;
  }

  isPast(): boolean {
    return this.epochMilliseconds < DateTime.nowInstant();
  }

  isFuture(): boolean {
    return this.epochMilliseconds > DateTime.nowInstant();
  }

  isToday(): boolean {
    return this.isSameDay(DateTime.now(this.timezone));
  }

  isTomorrow(): boolean {
    return this.isSameDay(DateTime.now(this.timezone).addDays(1));
  }

  isYesterday(): boolean {
    return this.isSameDay(DateTime.now(this.timezone).subDays(1));
  }

  /** The earliest of the given instants. Throws if given none. */
  static min(...values: DateTimeLike[]): DateTime {
    return DateTime.pick(values, (a, b) => a.isBefore(b));
  }

  /** The latest of the given instants. Throws if given none. */
  static max(...values: DateTimeLike[]): DateTime {
    return DateTime.pick(values, (a, b) => a.isAfter(b));
  }

  private static pick(
    values: DateTimeLike[],
    prefer: (candidate: DateTime, current: DateTime) => boolean,
  ): DateTime {
    if (values.length === 0) {
      throw new InvalidDateTimeError("min()/max() require at least one value.");
    }

    let best = DateTime.parse(values[0]!);

    for (const value of values.slice(1)) {
      const candidate = DateTime.parse(value);

      if (prefer(candidate, best)) {
        best = candidate;
      }
    }

    return best;
  }

  /** Whichever of the candidates is nearest to this instant, in either direction. */
  closest(...candidates: DateTimeLike[]): DateTime {
    return this.byDistance(candidates, (a, b) => a < b);
  }

  farthest(...candidates: DateTimeLike[]): DateTime {
    return this.byDistance(candidates, (a, b) => a > b);
  }

  private byDistance(
    candidates: DateTimeLike[],
    prefer: (candidateDistance: number, bestDistance: number) => boolean,
  ): DateTime {
    if (candidates.length === 0) {
      throw new InvalidDateTimeError("closest()/farthest() require at least one candidate.");
    }

    // Results are returned in the receiver's zone: `closest` answers "which of
    // these is nearest to *me*", so the answer belongs on the caller's clock.
    let best = this.coerceToThisZone(candidates[0]!);
    let bestDistance = Math.abs(best.epochMilliseconds - this.epochMilliseconds);

    for (const value of candidates.slice(1)) {
      const candidate = this.coerceToThisZone(value);
      const distance = Math.abs(candidate.epochMilliseconds - this.epochMilliseconds);

      if (prefer(distance, bestDistance)) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return best;
  }

  /**
   * The elapsed time from this instant to `other`, as an exact `Duration`.
   *
   * Always exact milliseconds, never calendar parts, "how long between these
   * two moments" has one true answer, whereas "how many months" depends on
   * which calendar you ask.
   */
  diff(other: DateTimeLike): Duration {
    return Duration.milliseconds(DateTime.parse(other).epochMilliseconds - this.epochMilliseconds);
  }

  /**
   * Exact elapsed time, positive when `other` is later.
   *
   * Hours and below measure **real elapsed time**: across a US spring-forward,
   * midnight to midnight is `diffInHours() === 23`. Days and above measure
   * **wall-clock calendar distance**, so the same pair is
   * `diffInDays() === 1`. That is not an inconsistency. They are answers to
   * different questions, and §10 requires both.
   */
  diffInMilliseconds(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.exactDiff(other, "millisecond", options);
  }

  diffInSeconds(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.exactDiff(other, "second", options);
  }

  diffInMinutes(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.exactDiff(other, "minute", options);
  }

  diffInHours(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.exactDiff(other, "hour", options);
  }

  /** Calendar days, measured on the wall clock in this instance's zone. */
  diffInDays(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.civilDiff(other, MS_PER_DAY, options);
  }

  diffInWeeks(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.civilDiff(other, MS_PER_WEEK, options);
  }

  diffInMonths(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.calendarDiff(other, addCivilMonths, options);
  }

  diffInQuarters(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.calendarDiff(other, addCivilQuarters, options);
  }

  diffInYears(other: DateTimeLike, options: DiffOptions = {}): number {
    return this.calendarDiff(other, addCivilYears, options);
  }

  private exactDiff(other: DateTimeLike, unit: string, options: DiffOptions): number {
    const elapsed = DateTime.parse(other).epochMilliseconds - this.epochMilliseconds;

    return finish(elapsed / EXACT_UNIT_MS[unit]!, options);
  }

  private civilDiff(other: DateTimeLike, unitMs: number, options: DiffOptions): number {
    const theirs = this.coerceToThisZone(other);

    return finish((theirs.civilMs - this.civilMs) / unitMs, options);
  }

  /**
   * Whole-unit difference for units of variable length, plus a fraction of
   * the partial unit at the end.
   *
   * Counts whole units by stepping from `this` until the next step would
   * overshoot, then measures how far into the following unit `other` sits.
   * Doing it this way (rather than dividing by an "average month") means
   * 31 Jan → 28 Feb is exactly 1 month, matching the clamping that
   * `addMonths` performs.
   */
  private calendarDiff(
    other: DateTimeLike,
    step: (civilMs: number, amount: number) => number,
    options: DiffOptions,
  ): number {
    const theirs = this.coerceToThisZone(other);
    const from = this.civilMs;
    const to = theirs.civilMs;

    if (from === to) {
      return finish(0, options);
    }

    const sign = to > from ? 1 : -1;

    let whole = 0;

    while (true) {
      const next = step(from, whole + sign);

      if (sign > 0 ? next > to : next < to) {
        break;
      }

      whole += sign;
    }

    const anchor = step(from, whole);
    const next = step(from, whole + sign);
    const span = next - anchor;
    const fraction = span === 0 ? 0 : (to - anchor) / span;

    return finish(whole + sign * Math.abs(fraction), options);
  }

  /** Reads `other` in this instance's zone, so calendar maths shares a calendar. */
  private coerceToThisZone(other: DateTimeLike): DateTime {
    const parsed = DateTime.parse(other);

    return parsed.timezone === this.timezone ? parsed : parsed.inTimezone(this.timezone);
  }

  /**
   * Read the **same instant** in a different zone.
   *
   * `DateTime.parse("2026-08-20T09:00", "Australia/Perth").inTimezone("Australia/Sydney")`
   * reads 11:00, the same moment, a different clock. `isEqual` still holds.
   */
  inTimezone(zone: TimezoneIdentifier): DateTime {
    return new DateTime(this.epochMilliseconds, DateTime.resolveZone(zone));
  }

  /** Alias of `inTimezone`, for Carbon's `setTimezone()` spelling. */
  setTimezone(zone: TimezoneIdentifier): DateTime {
    return this.inTimezone(zone);
  }

  /** Alias of `inTimezone`. */
  withTimezone(zone: TimezoneIdentifier): DateTime {
    return this.inTimezone(zone);
  }

  /** Alias of `inTimezone`. */
  toTimezone(zone: TimezoneIdentifier): DateTime {
    return this.inTimezone(zone);
  }

  /**
   * Keep the **wall clock** and change which instant is meant.
   *
   * 09:00 in Perth becomes 09:00 in Sydney, a different moment two hours
   * earlier in absolute terms. This is what you want for "the meeting is at
   * 9am wherever the office is"; `inTimezone` is what you want for
   * "what time is this log line locally". Mixing them up is the timezone bug.
   */
  keepLocalTime(zone: TimezoneIdentifier, options: ResolveOptions = {}): DateTime {
    const resolved = DateTime.resolveZone(zone);

    return new DateTime(
      instantFromCivilMs(resolved, this.civilMs, options.disambiguation),
      resolved,
    );
  }

  utc(): DateTime {
    return this.inTimezone("UTC");
  }

  /** Reads this instant in the host's own timezone. */
  local(): DateTime {
    return this.inTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }

  /** Whether this zone is currently observing daylight saving at this instant. */
  isDST(): boolean {
    // A zone observes DST at this instant if some other point in the same
    // year has a smaller offset; the standard offset is the minimum.
    const january = offsetFor(
      this.timezone,
      instantFromCivilMs(
        this.timezone,
        encodeCivil({
          ...this.components,
          month: 1,
          day: 1,
          hour: 12,
          minute: 0,
          second: 0,
          millisecond: 0,
        }),
      ),
    );
    const july = offsetFor(
      this.timezone,
      instantFromCivilMs(
        this.timezone,
        encodeCivil({
          ...this.components,
          month: 7,
          day: 1,
          hour: 12,
          minute: 0,
          second: 0,
          millisecond: 0,
        }),
      ),
    );

    return this.offset > Math.min(january, july);
  }

  isLeapYear(): boolean {
    return isLeapYear(this.year);
  }

  isMonday(): boolean {
    return this.dayOfWeek === 1;
  }

  isTuesday(): boolean {
    return this.dayOfWeek === 2;
  }

  isWednesday(): boolean {
    return this.dayOfWeek === 3;
  }

  isThursday(): boolean {
    return this.dayOfWeek === 4;
  }

  isFriday(): boolean {
    return this.dayOfWeek === 5;
  }

  isSaturday(): boolean {
    return this.dayOfWeek === 6;
  }

  isSunday(): boolean {
    return this.dayOfWeek === 0;
  }

  /** Saturday and Sunday. Configurable weekends arrive with business days. */
  isWeekend(): boolean {
    return this.dayOfWeek === 0 || this.dayOfWeek === 6;
  }

  isWeekday(): boolean {
    return !this.isWeekend();
  }

  isFirstDayOfMonth(): boolean {
    return this.day === 1;
  }

  isLastDayOfMonth(): boolean {
    return this.day === this.daysInMonth;
  }

  /** The next occurrence of `weekday`, strictly after this date, at midnight. */
  next(weekday: Weekday): DateTime {
    const delta = (weekday - this.dayOfWeek + 7) % 7 || 7;

    return this.addDays(delta).startOfDay();
  }

  /** The previous occurrence of `weekday`, strictly before this date. */
  previous(weekday: Weekday): DateTime {
    const delta = (this.dayOfWeek - weekday + 7) % 7 || 7;

    return this.subDays(delta).startOfDay();
  }

  /** An ISO year containing 53 weeks rather than the usual 52. */
  isLongYear(): boolean {
    return this.isoWeeksInYear() === 53;
  }

  /** Number of ISO weeks in this instance's ISO week-year: 52 or 53. */
  isoWeeksInYear(): number {
    // 28 December is always in the last ISO week of its ISO year, the one
    // date that is guaranteed to be, whichever way the year's edges fall.
    return this.with({ month: 12, day: 28 }).isoWeek;
  }

  /** Alias of `week()`, for Carbon's `->weekOfYear` spelling. */
  get weekOfYear(): number {
    return this.week();
  }

  /**
   * Which seven-day block of the month this date falls in, 1–5.
   *
   * This is Carbon's definition, `ceil(day / 7)`, and is deliberately *not*
   * a week number: it ignores weekday boundaries entirely, so the 7th is
   * always week 1 and the 8th always week 2 regardless of what day they land
   * on.
   */
  get weekOfMonth(): number {
    return Math.ceil(this.day / 7);
  }

  /** The ordinal century, where 1901–2000 is the 20th. */
  get century(): number {
    return Math.floor((this.year - 1) / 100) + 1;
  }

  /** Completed years between this date and now, i.e. someone's age. */
  get age(): number {
    return this.diffInYears(DateTime.now(this.timezone));
  }

  /**
   * The first day of the containing month, or the first `weekday` in it.
   *
   * `firstOfMonth(1)` is "the first Monday of this month".
   */
  firstOfMonth(weekday?: Weekday): DateTime {
    return this.firstOf("month", weekday);
  }

  lastOfMonth(weekday?: Weekday): DateTime {
    return this.lastOf("month", weekday);
  }

  /** The `nth` `weekday` of the month, or `null` if the month has no such day. */
  nthOfMonth(nth: number, weekday: Weekday): DateTime | null {
    return this.nthOf("month", nth, weekday);
  }

  firstOfQuarter(weekday?: Weekday): DateTime {
    return this.firstOf("quarter", weekday);
  }

  lastOfQuarter(weekday?: Weekday): DateTime {
    return this.lastOf("quarter", weekday);
  }

  nthOfQuarter(nth: number, weekday: Weekday): DateTime | null {
    return this.nthOf("quarter", nth, weekday);
  }

  firstOfYear(weekday?: Weekday): DateTime {
    return this.firstOf("year", weekday);
  }

  lastOfYear(weekday?: Weekday): DateTime {
    return this.lastOf("year", weekday);
  }

  nthOfYear(nth: number, weekday: Weekday): DateTime | null {
    return this.nthOf("year", nth, weekday);
  }

  private firstOf(unit: TimeUnit, weekday?: Weekday): DateTime {
    const start = this.startOf(unit);

    if (weekday === undefined) {
      return start;
    }

    return start.dayOfWeek === weekday ? start : start.next(weekday);
  }

  private lastOf(unit: TimeUnit, weekday?: Weekday): DateTime {
    const end = this.endOf(unit).startOfDay();

    if (weekday === undefined) {
      return end;
    }

    return end.dayOfWeek === weekday ? end : end.previous(weekday);
  }

  private nthOf(unit: TimeUnit, nth: number, weekday: Weekday): DateTime | null {
    if (!Number.isInteger(nth) || nth < 1) {
      return null;
    }

    const candidate = this.firstOf(unit, weekday).addWeeks(nth - 1);

    // A fifth Monday exists in some months and not others; rather than
    // silently spilling into the next month, say so.
    return candidate.isSame(unit, this) ? candidate : null;
  }

  /** The next day that is not a weekend, at midnight. */
  nextWeekday(): DateTime {
    let cursor = this.addDays(1).startOfDay();

    while (cursor.isWeekend()) {
      cursor = cursor.addDays(1);
    }

    return cursor;
  }

  previousWeekday(): DateTime {
    let cursor = this.subDays(1).startOfDay();

    while (cursor.isWeekend()) {
      cursor = cursor.subDays(1);
    }

    return cursor;
  }

  nextWeekendDay(): DateTime {
    let cursor = this.addDays(1).startOfDay();

    while (!cursor.isWeekend()) {
      cursor = cursor.addDays(1);
    }

    return cursor;
  }

  previousWeekendDay(): DateTime {
    let cursor = this.subDays(1).startOfDay();

    while (!cursor.isWeekend()) {
      cursor = cursor.subDays(1);
    }

    return cursor;
  }

  /**
   * Whether this date is a working day.
   *
   * Weekends default to Saturday and Sunday but are configurable, because
   * "the weekend" is Friday–Saturday in much of the Middle East and Sunday
   * alone in a few places. Holidays are supplied by the caller as a
   * predicate: this package has no business deciding whose public holidays
   * apply, and a hardcoded list would be wrong for most of its users and
   * stale for the rest.
   */
  isBusinessDay(options: BusinessDayOptions = {}): boolean {
    const weekend = options.weekend ?? WEEKEND_DEFAULT;

    if (weekend.includes(this.dayOfWeek)) {
      return false;
    }

    return options.isHoliday?.(this) !== true;
  }

  /**
   * Step forward `amount` business days, preserving the time of day.
   *
   * Counts *landings*, not calendar days: from a Friday, one business day is
   * the following Monday. A non-business starting date is not itself counted,
   * so `addBusinessDays(1)` from a Saturday is the following Monday too.
   */
  addBusinessDays(amount: number, options: BusinessDayOptions = {}): DateTime {
    let remaining = Math.abs(Math.trunc(amount));

    if (remaining === 0) {
      return this;
    }

    const step = amount < 0 ? -1 : 1;
    // A budget rather than an unbounded loop: a caller whose predicate marks
    // every day a holiday deserves an error, not a hung process. Ten years of
    // calendar days is far more than any real holiday calendar can consume.
    let guard = remaining * 14 + 3660;
    let cursor = this.addDays(step);

    while (true) {
      if (cursor.isBusinessDay(options) && --remaining === 0) {
        return cursor;
      }

      if (guard-- <= 0) {
        throw new InvalidDateTimeError(
          "addBusinessDays() could not find enough business days; check that " +
            "the weekend and isHoliday options leave some days available.",
        );
      }

      cursor = cursor.addDays(step);
    }
  }

  subBusinessDays(amount: number, options: BusinessDayOptions = {}): DateTime {
    return this.addBusinessDays(-amount, options);
  }

  nextBusinessDay(options: BusinessDayOptions = {}): DateTime {
    return this.addBusinessDays(1, options).startOfDay();
  }

  previousBusinessDay(options: BusinessDayOptions = {}): DateTime {
    return this.subBusinessDays(1, options).startOfDay();
  }

  startOfDecade(): DateTime {
    return this.startOf("decade");
  }

  endOfDecade(): DateTime {
    return this.endOf("decade");
  }

  startOfCentury(): DateTime {
    return this.startOf("century");
  }

  endOfCentury(): DateTime {
    return this.endOf("century");
  }

  /** Truncate toward the past. Identical to `startOf`, named for symmetry. */
  floor(unit: TimeUnit, options: WeekOptions = {}): DateTime {
    return this.startOf(unit, options);
  }

  /** Advance to the next boundary, unless already exactly on one. */
  ceil(unit: TimeUnit, options: WeekOptions = {}): DateTime {
    const start = this.truncatedCivilMs(unit, options);

    if (this.civilMs === start) {
      return this;
    }

    return this.withCivilMs(this.endCivilMs(unit, options) + 1, "compatible");
  }

  /** Snap to the nearest boundary; exact midpoints round up, as `Math.round` does. */
  round(unit: TimeUnit, options: WeekOptions = {}): DateTime {
    const start = this.truncatedCivilMs(unit, options);
    const nextStart = this.endCivilMs(unit, options) + 1;
    const halfway = (this.civilMs - start) * 2 >= nextStart - start;

    return this.withCivilMs(halfway ? nextStart : start, "compatible");
  }

  /** Read any unit by name, for code that is generic over units. */
  get(unit: TimeUnit): number {
    switch (unit) {
      case "millisecond":
        return this.millisecond;
      case "second":
        return this.second;
      case "minute":
        return this.minute;
      case "hour":
        return this.hour;
      case "day":
        return this.day;
      case "week":
        return this.week();
      case "month":
        return this.month;
      case "quarter":
        return this.quarter;
      case "year":
        return this.year;
      case "decade":
        return Math.floor(this.year / 10);
      case "century":
        return this.century;
    }
  }

  /** Add any unit by name. Exact below `day`, calendar-aware from `day` up. */
  addUnit(unit: TimeUnit, amount: number): DateTime {
    switch (unit) {
      case "millisecond":
        return this.addMilliseconds(amount);
      case "second":
        return this.addSeconds(amount);
      case "minute":
        return this.addMinutes(amount);
      case "hour":
        return this.addHours(amount);
      case "day":
        return this.addDays(amount);
      case "week":
        return this.addWeeks(amount);
      case "month":
        return this.addMonths(amount);
      case "quarter":
        return this.addQuarters(amount);
      case "year":
        return this.addYears(amount);
      case "decade":
        return this.addYears(amount * 10);
      case "century":
        return this.addYears(amount * 100);
    }
  }

  subUnit(unit: TimeUnit, amount: number): DateTime {
    return this.addUnit(unit, -amount);
  }

  /** Replace the calendar date, keeping the time of day. */
  setDate(year: number, month: number, day: number): DateTime {
    return this.with({ year, month, day });
  }

  /** Replace the time of day, keeping the calendar date. */
  setTime(hour: number, minute: number, second = 0, millisecond = 0): DateTime {
    return this.with({ hour, minute, second, millisecond });
  }

  /** Replace any single wall-clock field by name. */
  setUnit(
    unit: Exclude<TimeUnit, "week" | "quarter" | "decade" | "century">,
    value: number,
  ): DateTime {
    switch (unit) {
      case "millisecond":
        return this.withMillisecond(value);
      case "second":
        return this.withSecond(value);
      case "minute":
        return this.withMinute(value);
      case "hour":
        return this.withHour(value);
      case "day":
        return this.withDay(value);
      case "month":
        return this.withMonth(value);
      case "year":
        return this.withYear(value);
    }
  }

  /**
   * Month arithmetic that lets the day-of-month spill over, PHP-style.
   *
   * `addMonths` clamps, 31 January plus a month is 28/29 February, which is
   * this package's default because it is what people mean. PHP's `DateTime`
   * (and therefore Carbon's own `addMonths`) instead overflows to 2 or
   * 3 March. This method exists so a Carbon migration can reproduce the old
   * numbers where some downstream report depends on them.
   */
  addMonthsWithOverflow(amount: number): DateTime {
    const c = this.components;
    const total = c.year * 12 + (c.month - 1) + Math.trunc(amount);

    // `encodeCivil` normalises out-of-range days the way `Date.UTC` does,
    // which is exactly the overflow being asked for here.
    return this.withCivilMs(
      encodeCivil({ ...c, year: Math.floor(total / 12), month: modulo(total, 12) + 1 }),
    );
  }

  subMonthsWithOverflow(amount: number): DateTime {
    return this.addMonthsWithOverflow(-amount);
  }

  /** As `addYears`, but 29 February plus a year becomes 1 March, not 28 February. */
  addYearsWithOverflow(amount: number): DateTime {
    const c = this.components;

    return this.withCivilMs(encodeCivil({ ...c, year: c.year + Math.trunc(amount) }));
  }

  subYearsWithOverflow(amount: number): DateTime {
    return this.addYearsWithOverflow(-amount);
  }

  // Singular aliases for Carbon parity, each delegates to the plural
  // form with a count of 1.

  addMillisecond(): DateTime {
    return this.addMilliseconds(1);
  }
  addSecond(): DateTime {
    return this.addSeconds(1);
  }
  addMinute(): DateTime {
    return this.addMinutes(1);
  }
  addHour(): DateTime {
    return this.addHours(1);
  }
  addDay(): DateTime {
    return this.addDays(1);
  }
  addWeek(): DateTime {
    return this.addWeeks(1);
  }
  addMonth(): DateTime {
    return this.addMonths(1);
  }
  addQuarter(): DateTime {
    return this.addQuarters(1);
  }
  addYear(): DateTime {
    return this.addYears(1);
  }
  subMillisecond(): DateTime {
    return this.subMilliseconds(1);
  }
  subSecond(): DateTime {
    return this.subSeconds(1);
  }
  subMinute(): DateTime {
    return this.subMinutes(1);
  }
  subHour(): DateTime {
    return this.subHours(1);
  }
  subDay(): DateTime {
    return this.subDays(1);
  }
  subWeek(): DateTime {
    return this.subWeeks(1);
  }
  subMonth(): DateTime {
    return this.subMonths(1);
  }
  subQuarter(): DateTime {
    return this.subQuarters(1);
  }
  subYear(): DateTime {
    return this.subYears(1);
  }

  /** Constrain to a range. Bounds may be given in either order. */
  clamp(min: DateTimeLike, max: DateTimeLike): DateTime {
    const a = DateTime.parse(min).epochMilliseconds;
    const b = DateTime.parse(max).epochMilliseconds;
    const low = Math.min(a, b);
    const high = Math.max(a, b);

    if (this.epochMilliseconds < low) {
      return this.withInstant(low);
    }

    if (this.epochMilliseconds > high) {
      return this.withInstant(high);
    }

    return this;
  }

  /** The mean instant of the given values, read in the first one's zone. */
  static average(...values: DateTimeLike[]): DateTime {
    if (values.length === 0) {
      throw new InvalidDateTimeError("average() requires at least one value.");
    }

    const parsed = values.map((value) => DateTime.parse(value));
    const total = parsed.reduce((sum, value) => sum + value.epochMilliseconds, 0);

    return new DateTime(Math.round(total / parsed.length), parsed[0]!.timezone);
  }

  /**
   * Whether both render identically under `pattern`.
   *
   * Carbon's `isSameAs()`. A blunt but genuinely useful instrument: it lets a
   * caller define "same" however they like, `isSameAs("yyyy-'W'II", other)`
   * asks about ISO weeks without this package needing an opinion.
   */
  isSameAs(pattern: string, other: DateTimeLike): boolean {
    return this.format(pattern) === this.coerceToThisZone(other).format(pattern);
  }

  /** Same day-of-year, ignoring the year, a birthday or anniversary. */
  isBirthday(other?: DateTimeLike): boolean {
    const reference =
      other === undefined ? DateTime.now(this.timezone) : this.coerceToThisZone(other);

    return this.month === reference.month && this.day === reference.day;
  }

  isCurrentDay(): boolean {
    return this.isToday();
  }

  isCurrentWeek(options: WeekOptions = {}): boolean {
    return this.isSameWeek(DateTime.now(this.timezone), options);
  }

  isCurrentMonth(): boolean {
    return this.isSameMonth(DateTime.now(this.timezone));
  }

  isCurrentQuarter(): boolean {
    return this.isSameQuarter(DateTime.now(this.timezone));
  }

  isCurrentYear(): boolean {
    return this.isSameYear(DateTime.now(this.timezone));
  }

  isNextWeek(options: WeekOptions = {}): boolean {
    return this.isSame("week", DateTime.now(this.timezone).addWeeks(1), options);
  }

  isLastWeek(options: WeekOptions = {}): boolean {
    return this.isSame("week", DateTime.now(this.timezone).subWeeks(1), options);
  }

  isNextMonth(): boolean {
    return this.isSameMonth(DateTime.now(this.timezone).addMonths(1));
  }

  isLastMonth(): boolean {
    return this.isSameMonth(DateTime.now(this.timezone).subMonths(1));
  }

  isNextYear(): boolean {
    return this.isSameYear(DateTime.now(this.timezone).addYears(1));
  }

  isLastYear(): boolean {
    return this.isSameYear(DateTime.now(this.timezone).subYears(1));
  }

  /** Exactly midnight, hour, minute, second, and millisecond all zero. */
  isStartOfDay(): boolean {
    return this.isEqual(this.startOfDay());
  }

  /** The last representable millisecond of the day, `23:59:59.999`. */
  isEndOfDay(): boolean {
    return this.isEqual(this.endOfDay());
  }

  /** Alias of `isStartOfDay`. */
  isMidnight(): boolean {
    return this.isStartOfDay();
  }

  /** Exactly 12:00:00.000 local time. */
  isMidday(): boolean {
    return this.hour === 12 && this.minute === 0 && this.second === 0 && this.millisecond === 0;
  }

  /**
   * Describe this moment relative to another in words: `"3 days ago"`,
   * `"in 2 hours"`, `"now"`.
   *
   * `other` defaults to the current time. The phrasing comes from the host's
   * `Intl` data, so it is localized for every locale the platform supports
   * without this package shipping a single translated string.
   *
   * ### Deviation from Carbon
   *
   * Carbon renders a two-date comparison as `"3 days before"` / `"3 days
   * after"`, from its own bundled translations. `Intl` exposes only the
   * now-relative frames, so this method always says "ago"/"in", relative to
   * whatever reference was passed. Pass `syntax: "plain"` to get the bare
   * magnitude (`"3 days"`) and supply your own framing.
   *
   * Differences are truncated toward zero and calendar-aware: 31 January to
   * 28 February is `"1 month ago"`, matching `addMonths`.
   */
  diffForHumans(other?: DateTimeLike, options: HumanizeOptions = {}): string {
    const reference =
      other === undefined ? DateTime.now(this.timezone) : this.coerceToThisZone(other);
    const sign = this.compareTo(reference);

    // Decomposition always runs earlier → later so that every unit count is
    // non-negative; the direction is reapplied once, at render time.
    let cursor = sign < 0 ? this : reference;
    const target = sign < 0 ? reference : this;

    const parts = decompose(
      (unit) => wholeUnitsBetween(cursor, target, unit),
      (unit, amount) => {
        cursor = cursor.addUnit(unit, amount);
      },
      options,
    );

    return renderParts(parts, sign, options, options.locale ?? getDefaultLocale());
  }

  /** How long ago this moment was, or how far off it is: `"3 days ago"`. */
  fromNow(options: HumanizeOptions = {}): string {
    return this.diffForHumans(undefined, options);
  }

  /** The inverse of `fromNow()`: how *now* relates to this moment. */
  toNow(options: HumanizeOptions = {}): string {
    return DateTime.now(this.timezone).diffForHumans(this, options);
  }

  /** Alias of `diffForHumans`, reading `a.from(b)` as "a, relative to b". */
  from(other: DateTimeLike, options: HumanizeOptions = {}): string {
    return this.diffForHumans(other, options);
  }

  /** The inverse of `from()`: how `other` relates to this moment. */
  to(other: DateTimeLike, options: HumanizeOptions = {}): string {
    return this.coerceToThisZone(other).diffForHumans(this, options);
  }

  /**
   * Format using `date-fns` Unicode tokens (`yyyy-MM-dd HH:mm:ss`), rendered
   * in this instance's zone.
   *
   * Note these are *not* PHP `date()` tokens. `"Y-m-d"` will not do what a
   * Carbon user expects, and is rejected rather than silently misread.
   */
  format(pattern: string): string {
    return formatInstant(this.epochMilliseconds, this.timezone, pattern);
  }

  /** e.g. `2026-08-20T14:30:00.000+08:00`. */
  toISOString(): string {
    return this.format(ISO_PATTERN);
  }

  /** e.g. `2026-08-20`. */
  toISODate(): string {
    return this.format(ISO_DATE_PATTERN);
  }

  /** e.g. `14:30:00.000`. */
  toISOTime(): string {
    return this.format(ISO_TIME_PATTERN);
  }

  /** e.g. `2026-08-20T14:30:00+08:00`. */
  toRFC3339(): string {
    return this.format(RFC3339_PATTERN);
  }

  /** e.g. `Thu, 20 Aug 2026 14:30:00 +0800`. */
  toRFC2822(): string {
    return this.format(RFC2822_PATTERN);
  }

  /** `yyyy-MM-dd HH:mm:ss`, the form most databases and Carbon default to. */
  toDateTimeString(): string {
    return this.format("yyyy-MM-dd HH:mm:ss");
  }

  toDateString(): string {
    return this.toISODate();
  }

  toTimeString(): string {
    return this.format("HH:mm:ss");
  }

  /**
   * Format through `Intl.DateTimeFormat`, in this instance's zone.
   *
   * This is the localized counterpart to `format()`. `format()` takes a
   * pattern and produces exactly what you asked for, in English; this takes a
   * *description* and lets CLDR decide the layout, which is the only way to
   * get `"20 août 2026"` and `"2026年8月20日"` out of the same call.
   *
   * The zone is supplied automatically, so the result cannot silently drift
   * to the host's zone the way a bare `Intl.DateTimeFormat` call would.
   */
  toLocaleString(
    options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "medium" },
    locale: LocaleIdentifier = getDefaultLocale(),
  ): string {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: this.timezone }).format(
      this.toDate(),
    );
  }

  toLocaleDateString(
    options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
    locale?: LocaleIdentifier,
  ): string {
    return this.toLocaleString(options, locale ?? getDefaultLocale());
  }

  toLocaleTimeString(
    options: Intl.DateTimeFormatOptions = { timeStyle: "medium" },
    locale?: LocaleIdentifier,
  ): string {
    return this.toLocaleString(options, locale ?? getDefaultLocale());
  }

  /** This month's name in the given locale: `"August"`, `"août"`. */
  monthName(style: NameStyle = "long", locale?: LocaleIdentifier): string {
    return Locale.monthNames(style, locale ?? getDefaultLocale())[this.month - 1]!;
  }

  /** This weekday's name in the given locale: `"Thursday"`, `"jeudi"`. */
  dayName(style: NameStyle = "long", locale?: LocaleIdentifier): string {
    return Locale.weekdayNames(style, locale ?? getDefaultLocale())[this.dayOfWeek]!;
  }

  /** The day of the month as an ordinal, `"20th"`. */
  ordinalDay(locale?: LocaleIdentifier): string {
    return Locale.ordinal(this.day, locale ?? getDefaultLocale());
  }

  /**
   * Used automatically by `JSON.stringify`.
   *
   * Emits an offset-bearing ISO string rather than a bare `Z`, so the local
   * wall clock survives the round trip. The IANA identifier itself does not
   * fit in ISO 8601, if a consumer needs the zone *name* (and not merely the
   * offset), use `toObject()`, which keeps it.
   */
  toJSON(): string {
    return this.toISOString();
  }

  toString(): string {
    return this.toISOString();
  }

  /** A native `Date` at the same instant, for interop at the boundary. */
  toDate(): Date {
    return new Date(this.epochMilliseconds);
  }

  toTimestamp(): number {
    return this.epochMilliseconds;
  }

  toUnixTimestamp(): number {
    return this.unixTimestamp;
  }

  /** Wall-clock components plus the zone, lossless, unlike an ISO string. */
  toObject(): DateTimeComponents & { timezone: TimezoneIdentifier; offset: number } {
    return { ...this.components, timezone: this.timezone, offset: this.offset };
  }

  /** `[year, month, day, hour, minute, second, millisecond]`, month 1-based. */
  toArray(): [number, number, number, number, number, number, number] {
    const c = this.components;

    return [c.year, c.month, c.day, c.hour, c.minute, c.second, c.millisecond];
  }

  /** Makes `+dateTime` and relational operators work as instants. */
  valueOf(): number {
    return this.epochMilliseconds;
  }

  /** Renders sensibly in `console.log` and Vitest diffs. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `DateTime(${this.toISOString()} [${this.timezone}])`;
  }
}

/** Saturday and Sunday, the default non-working days. */
const WEEKEND_DEFAULT: readonly Weekday[] = [0, 6];

/**
 * Whole units from `from` to `to`, truncated, for the relative-time
 * decomposition. Both arguments are already in the same zone and ordered
 * earlier-first, so every result is non-negative.
 */
function wholeUnitsBetween(from: DateTime, to: DateTime, unit: HumanUnit): number {
  switch (unit) {
    case "year":
      return from.diffInYears(to);
    case "month":
      return from.diffInMonths(to);
    case "week":
      return from.diffInWeeks(to);
    case "day":
      return from.diffInDays(to);
    case "hour":
      return from.diffInHours(to);
    case "minute":
      return from.diffInMinutes(to);
    case "second":
      return from.diffInSeconds(to);
  }
}

/**
 * The first year of the decade or century containing `year`.
 *
 * Centuries are 1901–2000, 2001–2100, the ordinal convention Carbon uses,
 * where the first century is years 1–100. It is not the "the 2000s" reading a
 * marketing department would use, and the two disagree for exactly one year
 * in a hundred, so it is pinned by a test.
 */
function startYearOf(year: number, unit: "year" | "decade" | "century"): number {
  if (unit === "year") {
    return year;
  }

  if (unit === "decade") {
    return year - modulo(year, 10);
  }

  return year - modulo(year - 1, 100);
}

/** Remainder that stays non-negative for negative operands, unlike `%`. */
function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Applies the shared `absolute`/`float` handling to a raw difference. */
function finish(value: number, options: DiffOptions): number {
  const signed = options.float === true ? value : Math.trunc(value);

  // `+ 0` normalises `-0`, which is otherwise visible in test assertions.
  return (options.absolute === true ? Math.abs(signed) : signed) + 0;
}
