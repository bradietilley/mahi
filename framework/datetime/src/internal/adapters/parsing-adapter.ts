/**
 * Parsing, kept behind the adapter boundary (plan §24).
 *
 * ISO 8601 / RFC 3339 is handled by an explicit grammar here rather than by
 * `date-fns`'s `parseISO`, which is deliberately forgiving. Forgiving ISO
 * parsing is how `"2026-08-32"` becomes 1 September without anyone noticing.
 * `date-fns` is still the engine for *format-directed* parsing, where the
 * caller has supplied the grammar themselves.
 */

import { UTCDate } from "@date-fns/utc";
import { format as formatWithPattern, parse as parseWithPattern } from "date-fns";

import { InvalidFormatError } from "../../errors.js";
import type { DateTimeComponents } from "../../types.js";
import { componentsAreInRange, decodeCivil } from "../civil.js";

/**
 * The result of parsing a string that may or may not have pinned itself to a
 * specific instant.
 *
 * `offsetMs === null` means the string was a bare wall clock
 * (`"2026-08-20 14:30"`) and must still be resolved against a timezone.
 * A non-null offset means the string named its own instant
 * (`"2026-08-20T14:30+08:00"`), and the caller's timezone only affects how
 * it is subsequently *displayed*.
 */
export interface ParsedDateTime {
  components: DateTimeComponents;
  offsetMs: number | null;
  /** False for date-only input, so callers can apply midnight semantics. */
  hasTime: boolean;
}

const ISO_PATTERN =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Parse ISO 8601 / RFC 3339, plus the space-separated variant
 * (`"2026-08-20 14:30:00"`) that databases and Carbon both emit.
 *
 * Returns `null` rather than throwing so callers can chain fallbacks; the
 * public API is responsible for turning `null` into an error.
 */
export function parseISO(input: string): ParsedDateTime | null {
  const match = ISO_PATTERN.exec(input.trim());

  if (match === null) {
    return null;
  }

  const [, year, month, day, hour, minute, second, fraction, offset] = match;

  const components: DateTimeComponents = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    // Sub-millisecond precision is truncated, not rounded: this package's
    // resolution is milliseconds (plan §2) and rounding up could push an
    // instant into the next day.
    millisecond: fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0")),
  };

  if (!componentsAreInRange(components)) {
    return null;
  }

  let offsetMs: number | null = null;

  if (offset !== undefined) {
    offsetMs = parseOffset(offset);

    if (offsetMs === null) {
      return null;
    }
  }

  return { components, offsetMs, hasTime: hour !== undefined };
}

/**
 * `"Z"`, `"+08:00"`, `"+0800"`, or `"+08"` to milliseconds, or `null` if the
 * offset is out of range. `"+25:00"` matches the shape of an offset but names
 * no real one, and the regex alone cannot tell the difference.
 */
function parseOffset(offset: string): number | null {
  if (offset === "Z" || offset === "z") {
    return 0;
  }

  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return sign * (hours * 3_600_000 + minutes * 60_000);
}

/**
 * Format-directed parsing using `date-fns` tokens.
 *
 * `referenceCivilMs` supplies any field the pattern doesn't mention — parsing
 * `"14:30"` with `"HH:mm"` needs a date from somewhere.
 *
 * In strict mode the parsed result is re-formatted with the same pattern and
 * compared against the input. That round-trip is what makes strictness
 * meaningful: `date-fns` will happily read `"2026-02-31"` as `"yyyy-MM-dd"`
 * and hand back 3 March, and only the round-trip catches it.
 */
export function parseFormat(
  input: string,
  pattern: string,
  referenceCivilMs: number,
  strict: boolean,
): DateTimeComponents | null {
  let parsed: Date;
  try {
    parsed = parseWithPattern(input, pattern, new UTCDate(referenceCivilMs));
  } catch (error) {
    // date-fns throws on structurally invalid patterns (e.g. `YYYY` used
    // where `yyyy` was meant), which is a programmer error, not bad input.
    throw new InvalidFormatError(
      `Invalid format pattern "${pattern}": ${(error as Error).message}`,
    );
  }

  const civilMs = parsed.getTime();

  if (Number.isNaN(civilMs)) {
    return null;
  }

  if (strict && formatWithPattern(new UTCDate(civilMs), pattern) !== input.trim()) {
    return null;
  }

  return decodeCivil(civilMs);
}
