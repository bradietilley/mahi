/**
 * Timezone utilities that don't need a `DateTime` to be useful.
 *
 * There is deliberately no `Timezone` *class*: a zone is an identifier plus
 * a set of rules owned by the host's tzdata, and wrapping that in an object
 * would only invite it to be stored, serialised, and go stale relative to the
 * platform. The identifier string is the value; these are functions over it.
 */

import {
  assertValidTimezone,
  isValidTimezone,
  offsetFor,
  systemTimezone,
} from "./internal/adapters/timezone-adapter.js";
import { MS_PER_MINUTE } from "./internal/civil.js";
import type { TimezoneIdentifier } from "./types.js";

export const Timezone = {
  /** The host's own zone. */
  system: systemTimezone,

  /** Whether the host's tzdata recognises this identifier. */
  isValid: isValidTimezone,

  /** Returns the identifier, or throws `InvalidTimezoneError`. */
  assertValid: assertValidTimezone,

  /** Offset in milliseconds to add to UTC, at a given instant. */
  offsetAt(zone: TimezoneIdentifier, instant: Date | number = Date.now()): number {
    return offsetFor(zone, instant instanceof Date ? instant.getTime() : instant);
  },

  /** Offset in minutes to add to UTC, at a given instant. */
  offsetMinutesAt(zone: TimezoneIdentifier, instant: Date | number = Date.now()): number {
    return Timezone.offsetAt(zone, instant) / MS_PER_MINUTE;
  },

  /**
   * Whether the zone ever changes its offset during the given year.
   *
   * Sampling January and July catches every zone that observes daylight
   * saving in either hemisphere, which is what callers actually want to know;
   * it is not a general "has this zone ever changed its rules" test.
   */
  observesDST(zone: TimezoneIdentifier, year: number = new Date().getUTCFullYear()): boolean {
    const january = offsetFor(zone, Date.UTC(year, 0, 1, 12));
    const july = offsetFor(zone, Date.UTC(year, 6, 1, 12));

    return january !== july;
  },
} as const;
