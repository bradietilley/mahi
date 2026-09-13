/**
 * Package-level defaults.
 *
 * These are process-wide mutable settings, which is a deliberate trade: the
 * alternative is threading a zone and a week-start through every call site,
 * and in practice an application has exactly one answer for both. A framework
 * service provider is expected to call `setDefaultTimezone()` once during
 * boot from configuration; application code should not touch it afterwards.
 *
 * Nothing here affects an existing `DateTime`, instances capture their zone
 * at construction, so changing the default mid-process cannot retroactively
 * move an instant that has already been created.
 */

import { assertValidTimezone, systemTimezone } from "./internal/adapters/timezone-adapter.js";
import type { LocaleIdentifier, TimezoneIdentifier, Weekday } from "./types.js";

let defaultTimezone: TimezoneIdentifier | null = null;
let defaultWeekStartsOn: Weekday = 1;
let defaultLocale: LocaleIdentifier | null = null;

/**
 * The zone used by any factory that isn't given one explicitly.
 *
 * Falls back to the host's zone, resolved lazily on first use rather than at
 * import time so that a test setting `process.env.TZ` before touching this
 * package still gets what it asked for.
 */
export function getDefaultTimezone(): TimezoneIdentifier {
  defaultTimezone ??= systemTimezone();

  return defaultTimezone;
}

export function setDefaultTimezone(zone: TimezoneIdentifier): void {
  defaultTimezone = assertValidTimezone(zone);
}

/** Restores the host's zone as the default. */
export function resetDefaultTimezone(): void {
  defaultTimezone = null;
}

/**
 * The first day of the week for week-sensitive operations.
 *
 * Defaults to Monday (ISO 8601), not to the host locale: a locale-derived
 * default would make `startOfWeek()` return different answers on a developer
 * laptop and a production server.
 */
export function getDefaultWeekStartsOn(): Weekday {
  return defaultWeekStartsOn;
}

export function setDefaultWeekStartsOn(weekday: Weekday): void {
  defaultWeekStartsOn = weekday;
}

/**
 * The BCP 47 locale tag used by localized formatting and relative time.
 *
 * Unlike the timezone default, this one *does* fall back to the host's
 * locale: a wrong locale produces text in an unexpected language, which is
 * cosmetic and immediately visible, whereas a wrong timezone silently
 * produces the wrong instant. Server applications should still set it
 * explicitly from configuration.
 */
export function getDefaultLocale(): LocaleIdentifier {
  defaultLocale ??= new Intl.DateTimeFormat().resolvedOptions().locale || "en";

  return defaultLocale;
}

export function setDefaultLocale(locale: LocaleIdentifier): void {
  defaultLocale = locale;
}

/** Restores the host's locale as the default. */
export function resetDefaultLocale(): void {
  defaultLocale = null;
}
