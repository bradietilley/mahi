/**
 * Locale support (plan §21), built on `Intl` rather than on a bundled
 * translation dataset.
 *
 * ## The decision
 *
 * Carbon ships hundreds of translation files. A JavaScript package doing the
 * same faces a worse trade-off than a PHP one: every kilobyte is downloaded,
 * and "tree-shakeable locale data" is a promise that survives exactly until
 * someone writes `locale(userPreference)`. Meanwhile the host, every browser
 * and every Node build that isn't `small-icu`, already carries CLDR.
 *
 * So this module ships **no strings**. Month names, weekday names, date
 * patterns, and relative-time phrasing all come from `Intl`, which means:
 *
 * - the package is correct in every locale the platform supports, not in the
 *   three or four anyone would have got round to translating;
 * - locale data tracks the platform's CLDR updates rather than this package's
 *   release cadence;
 * - the bundle does not grow.
 *
 * The one thing `Intl` genuinely cannot supply is ordinal *suffixes*
 * ("1st", "2nd"), which is why `registerOrdinal` exists. See `ordinal`.
 *
 * ## Locale vs. week start
 *
 * `firstDayOfWeek` reports what a locale *conventionally* uses. It is
 * deliberately not wired into `startOfWeek()` by default: a locale-derived
 * week start makes the same code produce different reports on a developer's
 * laptop and a production server. Pass it explicitly if you want it.
 */

import { getDefaultLocale } from "./config.js";
import type { LocaleIdentifier, Weekday } from "./types.js";

/** How much of a name to render. Matches `Intl`'s own vocabulary. */
export type NameStyle = "long" | "short" | "narrow";

/**
 * Turns a number and its CLDR ordinal plural category into an ordinal string.
 *
 * @see Locale.registerOrdinal
 */
export type OrdinalRule = (value: number, category: Intl.LDMLPluralRule) => string;

/**
 * Ordinal suffix rules, keyed by primary language subtag.
 *
 * Only English is built in, and that is a considered position rather than
 * laziness: ordinal *suffixes* are a minority feature across languages, the
 * ones that have them disagree about grammatical gender and agreement
 * (French writes "1er"/"1re"), and CLDR does not expose the suffixes
 * themselves, only the plural categories they attach to. Guessing would
 * produce confidently wrong text. Anything unregistered falls back to the
 * locale's plain numeral, which is what most languages use in dates anyway.
 */
const ordinalRules = new Map<string, OrdinalRule>([
  [
    "en",
    (value, category) => {
      const suffix =
        category === "one" ? "st" : category === "two" ? "nd" : category === "few" ? "rd" : "th";

      return `${value}${suffix}`;
    },
  ],
]);

/** 2021-01-03 was a Sunday, giving a clean week to read weekday names from. */
const WEEKDAY_ANCHOR = Date.UTC(2021, 0, 3);
const DAY_MS = 86_400_000;

export const Locale = {
  /** The configured locale, or the host's if none has been set. */
  current(): LocaleIdentifier {
    return getDefaultLocale();
  },

  /** Whether the host's `Intl` data recognises this tag. */
  isSupported(locale: LocaleIdentifier): boolean {
    try {
      return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0;
    } catch {
      // An outright malformed tag throws `RangeError` rather than returning
      // an empty list.
      return false;
    }
  },

  /**
   * The locale actually used when `locale` is requested.
   *
   * Asking for `"en-XX"` gets you `"en"`; asking for something unsupported
   * gets you the host's fallback. Useful for telling a user their language
   * isn't available rather than silently rendering English.
   */
  resolve(locale: LocaleIdentifier = getDefaultLocale()): LocaleIdentifier {
    return new Intl.DateTimeFormat(locale).resolvedOptions().locale;
  },

  /** Month names, January first, in the locale's own script. */
  monthNames(style: NameStyle = "long", locale: LocaleIdentifier = getDefaultLocale()): string[] {
    const formatter = new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" });

    return Array.from({ length: 12 }, (_, index) =>
      formatter.format(new Date(Date.UTC(2021, index, 15))),
    );
  },

  /**
   * Weekday names, indexed to match `DateTime.dayOfWeek`, index `0` is
   * Sunday, regardless of where the locale starts its week.
   */
  weekdayNames(style: NameStyle = "long", locale: LocaleIdentifier = getDefaultLocale()): string[] {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" });

    return Array.from({ length: 7 }, (_, index) =>
      formatter.format(new Date(WEEKDAY_ANCHOR + index * DAY_MS)),
    );
  },

  /**
   * The day the locale conventionally starts its week on.
   *
   * Falls back to Monday when the host does not expose week info, which is
   * both the ISO answer and this package's default.
   */
  firstDayOfWeek(locale: LocaleIdentifier = getDefaultLocale()): Weekday {
    const info = weekInfo(locale);

    if (info === null) {
      return 1;
    }

    // CLDR numbers days 1 (Monday) through 7 (Sunday); `Weekday` is 0
    // (Sunday) through 6.
    return (info.firstDay % 7) as Weekday;
  },

  /** The days the locale considers the weekend, in `Weekday` numbering. */
  weekendDays(locale: LocaleIdentifier = getDefaultLocale()): Weekday[] {
    const info = weekInfo(locale);

    if (info === null) {
      return [0, 6];
    }

    return info.weekend.map((day) => (day % 7) as Weekday);
  },

  /**
   * Render `value` as an ordinal: `21` becomes `"21st"` in English.
   *
   * Locales without a registered rule get the locale's plain numeral. See
   * `ordinalRules` for why that is the honest default rather than a bug.
   */
  ordinal(value: number, locale: LocaleIdentifier = getDefaultLocale()): string {
    const language = primaryLanguage(locale);
    const rule = ordinalRules.get(language);

    if (rule === undefined) {
      return new Intl.NumberFormat(locale).format(value);
    }

    return rule(value, new Intl.PluralRules(locale, { type: "ordinal" }).select(value));
  },

  /**
   * Teach the package a language's ordinal suffixes.
   *
   * ```ts
   * Locale.registerOrdinal("fr", (value) => (value === 1 ? "1er" : `${value}e`));
   * ```
   *
   * Keyed by primary language subtag, so registering `"fr"` covers
   * `"fr-CA"` as well.
   */
  registerOrdinal(language: string, rule: OrdinalRule): void {
    ordinalRules.set(primaryLanguage(language), rule);
  },

  /** Whether a language has a registered ordinal rule. */
  hasOrdinalRule(language: string): boolean {
    return ordinalRules.has(primaryLanguage(language));
  },
} as const;

function primaryLanguage(locale: LocaleIdentifier): string {
  return locale.split(/[-_]/u)[0]!.toLowerCase();
}

/** CLDR week metadata, where the host exposes it. */
interface WeekInfo {
  firstDay: number;
  weekend: number[];
}

/**
 * `Intl.Locale`'s week info moved from a property to a method mid-standard,
 * and older runtimes have neither. All three cases are handled rather than
 * assuming whichever one the developer's Node happens to implement.
 */
function weekInfo(locale: LocaleIdentifier): WeekInfo | null {
  try {
    const resolved = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };

    const info = resolved.getWeekInfo?.() ?? resolved.weekInfo ?? null;

    if (info === null || info === undefined) {
      return null;
    }

    return { firstDay: info.firstDay, weekend: [...info.weekend] };
  } catch {
    return null;
  }
}
