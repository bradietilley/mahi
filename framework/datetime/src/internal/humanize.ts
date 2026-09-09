/**
 * Relative-time phrasing (plan §15), built entirely on `Intl` rather than on
 * a shipped translation table.
 *
 * ## Why no locale data
 *
 * Carbon ships ~800 hand-maintained translation files. Reproducing that here
 * would mean either bundling a large dataset into a package whose job is
 * arithmetic, or shipping three languages and calling it "localization".
 * `Intl.RelativeTimeFormat` already contains CLDR's phrasing for every locale
 * the host knows, including plural rules that English speakers habitually get
 * wrong (Polish has three plural forms; Arabic has six). Using it means the
 * package ships no strings at all and is correct in more locales than we
 * could ever hand-write.
 *
 * The cost is that `Intl` only exposes the *now*-relative frames ("3 days
 * ago", "in 3 days") and not Carbon's two-date frames ("3 days before").
 * That deviation is documented rather than papered over — see
 * `HumanizeOptions.syntax`.
 *
 * ## Composition for multi-unit output
 *
 * `Intl.RelativeTimeFormat` renders exactly one unit. For `parts > 1` the
 * magnitudes are rendered with `Intl.NumberFormat`'s unit style, joined with
 * `Intl.ListFormat`, and wrapped in a frame *derived at runtime* from the
 * single-unit output: format `-3 day`, format `3 day` as a bare quantity, and
 * the text either side of the quantity is the frame. Where a locale phrases
 * the two differently enough that the quantity is not a substring (so the
 * frame cannot be recovered honestly), the derivation returns `null` and the
 * caller falls back to single-unit output. Half-translated output is worse
 * than less-detailed output.
 */

import type { HumanUnit, HumanizeOptions, LocaleIdentifier } from "../types.js";

/** Largest to smallest. The order the decomposition consumes them in. */
export const HUMAN_UNITS: readonly HumanUnit[] = [
  "year",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
];

/** One unit's worth of an already-decomposed difference. */
export interface HumanPart {
  unit: HumanUnit;
  /** Always non-negative; the overall sign is carried separately. */
  value: number;
}

/**
 * Render a decomposed difference.
 *
 * `sign` is `-1` when the described moment is in the past relative to the
 * reference, matching `Intl.RelativeTimeFormat`'s own convention, `1` when it
 * is in the future, and `0` when the two coincide.
 */
export function renderParts(
  parts: readonly HumanPart[],
  sign: -1 | 0 | 1,
  options: HumanizeOptions,
  locale: LocaleIdentifier,
): string {
  const style = options.short === true ? "narrow" : "long";
  const minimumUnit = options.minimumUnit ?? "second";

  if (parts.length === 0) {
    return options.justNow === false
      ? framedSingle(locale, style, options.syntax, 0, minimumUnit)
      : nowPhrase(locale, style, minimumUnit);
  }

  const [first, ...rest] = parts as [HumanPart, ...HumanPart[]];

  if (rest.length === 0) {
    return framedSingle(locale, style, options.syntax, sign * first.value, first.unit);
  }

  const quantities = parts.map((part) => quantity(locale, style, part.value, part.unit));
  const joined = new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(quantities);

  if (options.syntax === "plain") {
    return joined;
  }

  const frame = deriveFrame(locale, style, sign * first.value, first.unit);

  // No recoverable frame for this locale: a correct single-unit phrase beats
  // an English "ago" bolted onto localized magnitudes.
  if (frame === null) {
    return framedSingle(locale, style, options.syntax, sign * first.value, first.unit);
  }

  return frame.prefix + joined + frame.suffix;
}

/**
 * Split an elapsed difference into descending units, largest first.
 *
 * Calendar-aware: years and months come from calendar stepping (so 31 January
 * to 28 February is "1 month", matching `addMonths`), and only hours and
 * below are computed from exact elapsed milliseconds.
 *
 * `step` is supplied by the caller so this module never imports `DateTime`,
 * keeping the dependency arrow pointing one way.
 */
export function decompose(
  wholeUnitsBetween: (unit: HumanUnit) => number,
  advance: (unit: HumanUnit, amount: number) => void,
  options: HumanizeOptions,
): HumanPart[] {
  // Tolerating an inverted range costs one `Math.min` and avoids a caller
  // who transposed the two options getting a silent, permanent "now".
  const a = HUMAN_UNITS.indexOf(options.maximumUnit ?? "year");
  const b = HUMAN_UNITS.indexOf(options.minimumUnit ?? "second");
  const maximumIndex = Math.min(a, b);
  const minimumIndex = Math.max(a, b);
  const wanted = Math.max(1, Math.trunc(options.parts ?? 1));

  const parts: HumanPart[] = [];

  for (let index = maximumIndex; index <= minimumIndex; index++) {
    const unit = HUMAN_UNITS[index]!;
    const value = wholeUnitsBetween(unit);

    // Leading zeroes are skipped entirely ("4 hours", not "0 days, 4 hours"),
    // but once a unit has been emitted the sequence must stay contiguous or
    // "1 day, 5 seconds" would read as if the hours and minutes were zero
    // when they were merely dropped.
    if (value === 0 && parts.length === 0) {
      continue;
    }

    parts.push({ unit, value });
    advance(unit, value);

    if (parts.length === wanted) {
      break;
    }
  }

  // Trailing zeroes carry no information: "2 hours, 0 minutes" is just
  // "2 hours" with extra words.
  while (parts.length > 0 && parts[parts.length - 1]!.value === 0) {
    parts.pop();
  }

  return parts;
}

type Style = "long" | "narrow";

function framedSingle(
  locale: LocaleIdentifier,
  style: Style,
  syntax: HumanizeOptions["syntax"],
  signedValue: number,
  unit: HumanUnit,
): string {
  if (syntax === "plain") {
    return quantity(locale, style, Math.abs(signedValue), unit);
  }

  return relativeFormatter(locale, style, "always").format(signedValue, unit);
}

/** The locale's word for "no meaningful time has passed" — `"now"`, `"ahora"`. */
function nowPhrase(locale: LocaleIdentifier, style: Style, unit: HumanUnit): string {
  // `numeric: "auto"` is what turns `0 second` into the idiomatic phrase
  // rather than a literal "in 0 seconds".
  return relativeFormatter(locale, style, "auto").format(0, unit);
}

function quantity(locale: LocaleIdentifier, style: Style, value: number, unit: HumanUnit): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: style === "narrow" ? "narrow" : "long",
  }).format(value);
}

/**
 * Recover the "…ago" / "in …" wrapper around a quantity for this locale.
 *
 * Returns `null` when the relative phrase does not literally contain the
 * quantity phrase, which is the signal that the two `Intl` formatters word
 * things differently enough that splicing them would be guesswork.
 */
function deriveFrame(
  locale: LocaleIdentifier,
  style: Style,
  signedValue: number,
  unit: HumanUnit,
): { prefix: string; suffix: string } | null {
  const phrase = relativeFormatter(locale, style, "always").format(signedValue, unit);
  const bare = quantity(locale, style, Math.abs(signedValue), unit);

  const located = locate(phrase, bare);

  if (located === null) {
    return null;
  }

  return {
    prefix: phrase.slice(0, located.index),
    suffix: phrase.slice(located.index + located.length),
  };
}

/**
 * Find `needle` inside `haystack`, treating every flavour of space as
 * equivalent.
 *
 * This is not fussiness. `Intl.NumberFormat` separates a French quantity from
 * its unit with U+00A0, while `Intl.RelativeTimeFormat` uses an ordinary
 * space in the same position — so a plain `indexOf` reports "no match" for
 * `"2 jours"` inside `"il y a 2 jours"` and every non-English locale silently
 * loses multi-part output.
 */
function locate(haystack: string, needle: string): { index: number; length: number } | null {
  const pattern = new RegExp(
    needle
      .split(/\s+/u)
      .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s"),
    "u",
  );

  const match = pattern.exec(haystack);

  return match === null ? null : { index: match.index, length: match[0].length };
}

/**
 * `Intl` formatter construction is comparatively expensive and relative time
 * tends to be rendered per-row in a list, so the small fixed set of
 * (locale, style, numeric) combinations is cached.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(
  locale: LocaleIdentifier,
  style: Style,
  numeric: "always" | "auto",
): Intl.RelativeTimeFormat {
  const key = `${locale}\u0000${style}\u0000${numeric}`;
  let formatter = relativeFormatters.get(key);

  if (formatter === undefined) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric, style });
    relativeFormatters.set(key, formatter);
  }

  return formatter;
}
