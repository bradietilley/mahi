/**
 * `@mahiframework/datetime`, an immutable, timezone-aware temporal model.
 *
 * The public surface is deliberately narrow: `DateTime`, `Duration`, the
 * `Timezone` helpers, the error types, and the vocabulary types. Nothing
 * under `internal/` is exported, and no `date-fns` type appears in any public
 * signature, so the implementation library can be swapped without a breaking
 * change (plan §24, §34).
 *
 * ```ts
 * const expires = DateTime.now().addDays(7).endOfDay();
 * const perth = DateTime.now().inTimezone("Australia/Perth");
 * const age = birthday.diffInYears(DateTime.now());
 * ```
 */

export { DateTime } from "./date-time.js";
export type { DateTimeLike } from "./date-time.js";

export { Duration } from "./duration.js";
export type { DurationInput, DurationParts } from "./duration.js";

export { Interval } from "./interval.js";

export { Period } from "./period.js";
export type { PeriodFilter, PeriodOptions } from "./period.js";

export { Timezone } from "./timezone.js";

export { Locale } from "./locale.js";
export type { NameStyle, OrdinalRule } from "./locale.js";

export {
  getDefaultTimezone,
  setDefaultTimezone,
  resetDefaultTimezone,
  getDefaultWeekStartsOn,
  setDefaultWeekStartsOn,
  getDefaultLocale,
  setDefaultLocale,
  resetDefaultLocale,
} from "./config.js";

export {
  AmbiguousTimeError,
  DateTimeError,
  InvalidDateTimeError,
  InvalidDurationError,
  InvalidFormatError,
  InvalidIntervalError,
  InvalidTimezoneError,
} from "./errors.js";

export type {
  BetweenOptions,
  BusinessDayOptions,
  CalendarUnit,
  DateTimeComponents,
  DiffOptions,
  Disambiguation,
  ExactUnit,
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
