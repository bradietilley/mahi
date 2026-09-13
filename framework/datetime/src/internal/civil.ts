/**
 * "Civil time" is a wall-clock reading with no zone attached. Internally we
 * encode one as a number of milliseconds, using the UTC timeline purely as a
 * convenient integer encoding of `(year, month, day, hour, ...)`, a civil
 * millisecond value is **not** an instant and must never be handed to
 * anything that expects one.
 *
 * The relationship that holds everywhere in this package is:
 *
 *     civilMs = instant + utcOffset
 *
 * which is why `TimezoneAdapter.offsetFor` returning a signed offset (in the
 * "add this to UTC" direction) matters so much. Get that sign backwards and
 * every timezone in the western hemisphere silently breaks.
 */

import type { DateTimeComponents } from "../types.js";

/**
 * Encode wall-clock components as civil milliseconds.
 *
 * Out-of-range fields normalise the way `Date.UTC` does (month 13 rolls into
 * the next January), which callers rely on for things like "day 0 of next
 * month" tricks. `setUTCFullYear` is used rather than `Date.UTC` because
 * `Date.UTC` maps years 0–99 into the 1900s, so `Date.UTC(50, 0, 1)` is 1950,
 * not the year 50.
 */
export function encodeCivil(components: DateTimeComponents): number {
  const date = new Date(0);
  date.setUTCFullYear(components.year, components.month - 1, components.day);
  date.setUTCHours(components.hour, components.minute, components.second, components.millisecond);

  return date.getTime();
}

/** Decode civil milliseconds back into wall-clock components. */
export function decodeCivil(civilMs: number): DateTimeComponents {
  const date = new Date(civilMs);

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

/** `0` = Sunday … `6` = Saturday, for a civil millisecond value. */
export function civilWeekday(civilMs: number): number {
  return new Date(civilMs).getUTCDay();
}

/** Day of the year, 1-based, for a civil millisecond value. */
export function civilDayOfYear(civilMs: number): number {
  const components = decodeCivil(civilMs);
  const startOfYear = encodeCivil({
    year: components.year,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  return Math.floor((civilMs - startOfYear) / MS_PER_DAY) + 1;
}

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_WEEK = 604_800_000;

/**
 * Whether every component is a finite integer within its natural range.
 * Used by the strict constructors so that `create(2026, 2, 30)` is rejected
 * rather than silently rolling over into March.
 */
export function componentsAreInRange(components: DateTimeComponents): boolean {
  const { year, month, day, hour, minute, second, millisecond } = components;
  const values = [year, month, day, hour, minute, second, millisecond];

  if (values.some((value) => !Number.isInteger(value))) {
    return false;
  }

  if (month < 1 || month > 12) {
    return false;
  }

  if (day < 1 || day > daysInCivilMonth(year, month)) {
    return false;
  }

  if (hour < 0 || hour > 23) {
    return false;
  }

  if (minute < 0 || minute > 59) {
    return false;
  }

  if (second < 0 || second > 59) {
    return false;
  }

  if (millisecond < 0 || millisecond > 999) {
    return false;
  }

  return true;
}

/** Number of days in a given 1-based month of a given year. */
export function daysInCivilMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);

  return date.getUTCDate();
}

/** Proleptic Gregorian leap year test. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
