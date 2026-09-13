/**
 * Calendar arithmetic on civil milliseconds, delegated to `date-fns` (plan
 * §24). The `UTCDate` wrapper from `@date-fns/utc` is what makes this safe:
 * `date-fns` reads and writes date fields through the *host's* local
 * timezone by default, which would make results depend on the machine the
 * code runs on. `UTCDate` pins every field access to UTC, which is exactly
 * the civil-millisecond encoding described in `civil.ts`.
 *
 * Only calendar units live here. Exact units (hours and below) are plain
 * addition on the instant and never touch a calendar, so they'd only be
 * obscured by routing through a library.
 */

import { UTCDate } from "@date-fns/utc";
import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  addYears,
  getDaysInMonth,
  getDaysInYear,
  getISOWeek,
  getISOWeekYear,
  getWeek,
  getWeekYear,
} from "date-fns";

import type { Weekday } from "../../types.js";

/**
 * Add `amount` months to a civil timestamp, clamping the day-of-month.
 *
 * The clamp is the behaviour Carbon, `date-fns`, and `Temporal`'s
 * `"constrain"` mode all agree on: 31 January plus one month is 28 (or 29)
 * February, not 2 or 3 March. It is deliberately **not** reversible,
 * `addMonths(1).subMonths(1)` on 31 January returns 28 February, and the
 * test suite pins that rather than pretending otherwise.
 */
export function addCivilMonths(civilMs: number, amount: number): number {
  return addMonths(new UTCDate(civilMs), amount).getTime();
}

export function addCivilQuarters(civilMs: number, amount: number): number {
  return addQuarters(new UTCDate(civilMs), amount).getTime();
}

/** Adds calendar years, clamping 29 February to 28 February in common years. */
export function addCivilYears(civilMs: number, amount: number): number {
  return addYears(new UTCDate(civilMs), amount).getTime();
}

export function addCivilDays(civilMs: number, amount: number): number {
  return addDays(new UTCDate(civilMs), amount).getTime();
}

export function addCivilWeeks(civilMs: number, amount: number): number {
  return addWeeks(new UTCDate(civilMs), amount).getTime();
}

export function civilDaysInMonth(civilMs: number): number {
  return getDaysInMonth(new UTCDate(civilMs));
}

export function civilDaysInYear(civilMs: number): number {
  return getDaysInYear(new UTCDate(civilMs));
}

/**
 * Locale-independent week number.
 *
 * `firstWeekContainsDate: 1` is pinned rather than left to a locale so that
 * the same date yields the same week number on every machine; ISO semantics
 * (`firstWeekContainsDate: 4`) are available separately as `civilISOWeek`.
 */
export function civilWeek(civilMs: number, weekStartsOn: Weekday): number {
  return getWeek(new UTCDate(civilMs), { weekStartsOn, firstWeekContainsDate: 1 });
}

export function civilWeekYear(civilMs: number, weekStartsOn: Weekday): number {
  return getWeekYear(new UTCDate(civilMs), { weekStartsOn, firstWeekContainsDate: 1 });
}

export function civilISOWeek(civilMs: number): number {
  return getISOWeek(new UTCDate(civilMs));
}

export function civilISOWeekYear(civilMs: number): number {
  return getISOWeekYear(new UTCDate(civilMs));
}
