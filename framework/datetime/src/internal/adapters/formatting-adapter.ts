/**
 * The only place that knows `date-fns-tz` handles formatting (plan §24).
 *
 * Pattern tokens are `date-fns`'s Unicode-style tokens (`yyyy`, `MM`, `dd`,
 * `HH`, `mm`, `ss`), *not* PHP's single-letter `date()` tokens. This is a
 * deliberate deviation from Carbon: PHP's `Y-m-d H:i:s` and Unicode's
 * `yyyy-MM-dd HH:mm:ss` overlap enough to be confusable but differ enough to
 * be dangerous (`d` means day-of-month in PHP but day-of-year-ish nowhere,
 * `i` means minutes in PHP and nothing in Unicode), so silently accepting
 * both would produce quiet wrong answers. Documented in the migration notes.
 */

import { formatInTimeZone } from "date-fns-tz";

import { InvalidFormatError } from "../../errors.js";
import type { TimezoneIdentifier } from "../../types.js";

/** ISO 8601 / RFC 3339 with milliseconds and a numeric offset (`Z` for UTC). */
export const ISO_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX";
export const ISO_DATE_PATTERN = "yyyy-MM-dd";
export const ISO_TIME_PATTERN = "HH:mm:ss.SSS";
/** RFC 3339 forbids the bare `Z`-less form and uses seconds precision. */
export const RFC3339_PATTERN = "yyyy-MM-dd'T'HH:mm:ssXXX";
export const RFC2822_PATTERN = "EEE, dd MMM yyyy HH:mm:ss xx";

export function formatInstant(instant: number, zone: TimezoneIdentifier, pattern: string): string {
  try {
    return formatInTimeZone(new Date(instant), zone, pattern);
  } catch (error) {
    throw new InvalidFormatError(
      `Could not format with pattern "${pattern}": ${(error as Error).message}`,
    );
  }
}
