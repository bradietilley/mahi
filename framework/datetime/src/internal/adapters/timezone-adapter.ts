/**
 * The only place in the package that knows `date-fns-tz` exists for the
 * purposes of *timezone rules*. Everything above this file works in terms of
 * "instant" and "civil milliseconds" (plan §24).
 *
 * Two operations matter, and they are not symmetric:
 *
 * 1. instant → civil, which is total: every instant has exactly one
 *    wall-clock reading in a given zone.
 * 2. civil → instant, which is **partial**: a wall-clock reading may map to
 *    zero instants (DST gap) or two (DST overlap). That asymmetry is the
 *    single most important fact about timezone handling, and it is why
 *    `instantFromCivil` takes a `Disambiguation` policy while
 *    `civilFromInstant` does not.
 */

import { AmbiguousTimeError, InvalidTimezoneError } from "../../errors.js";
import type { DateTimeComponents, Disambiguation, TimezoneIdentifier } from "../../types.js";
import { decodeCivil, encodeCivil, MS_PER_DAY, MS_PER_SECOND } from "../civil.js";

/**
 * One cached `Intl.DateTimeFormat` per zone.
 *
 * Every calendar operation in the package resolves a wall clock against a
 * zone, and each resolution needs several offset lookups (see
 * `instantFromCivilMs`). Constructing a formatter per lookup made zone-aware
 * arithmetic roughly three times more expensive than it needed to be — for
 * an object that is immutable and depends only on the zone. The map is
 * unbounded, which is fine: it is keyed by IANA identifier, and there are
 * fewer than a thousand of those in existence.
 */
const zoneFormatters = new Map<TimezoneIdentifier, Intl.DateTimeFormat>();

function formatterFor(zone: TimezoneIdentifier): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(zone);

  if (cached !== undefined) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // `hourCycle: "h23"` so midnight reads as hour 0 rather than 24, and
      // `era` so that dates before year 1 can be mapped back to astronomical
      // year numbering instead of silently reading as their AD counterparts.
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new InvalidTimezoneError(zone);
  }

  zoneFormatters.set(zone, formatter);

  return formatter;
}

/**
 * The offset, in milliseconds, to **add to UTC** to get wall-clock time in
 * `zone` at `instant`. Negative west of Greenwich.
 *
 * This asks `Intl` for the wall clock at a known instant and subtracts, which
 * is the *instant → offset* direction. That distinction matters more than it
 * looks:
 *
 * `date-fns-tz`'s `getTimezoneOffset` answers the opposite question. Despite
 * the name it takes "a date whose values represent the local time" — it reads
 * its argument's fields through the *host's* zone — so it both depends on
 * `process.env.TZ` and returns the wrong answer on a transition day (UTC−4
 * for 04:00Z on a US spring-forward date, where the truth is UTC−5). Building
 * on it would have made every result in this package machine-dependent.
 *
 * Resolution is whole seconds, which is exact: no zone has ever used a
 * sub-second offset. How far back the *historical* offsets are accurate is
 * bounded by the host's own ICU data, not by this package.
 */
export function offsetFor(zone: TimezoneIdentifier, instant: number): number {
  // `Intl` treats an empty or whitespace-only zone as "unspecified" and
  // quietly substitutes the *host's* zone, so `DateTime.now("")` would return
  // a different instant's wall clock on every machine — precisely the
  // non-determinism this package exists to prevent. Caught here rather than
  // at the public API because every zone lookup funnels through this
  // function.
  if (zone.trim() === "") {
    throw new InvalidTimezoneError(zone);
  }

  if (!Number.isFinite(instant)) {
    return 0;
  }

  const parts = formatterFor(zone).formatToParts(new Date(instant));

  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let bc = false;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        // Defensive: an engine honouring `h24` instead of `h23` would report
        // midnight as 24, which would otherwise shift the offset a day.
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      case "era":
        bc = part.value.startsWith("B");
        break;
      default:
        break;
    }
  }

  if (Number.isNaN(year)) {
    throw new InvalidTimezoneError(zone);
  }

  // `Intl` counts BC years from 1 with no year zero; the rest of this package
  // uses astronomical numbering, where 1 BC is year 0.
  const civil = encodeCivil({
    year: bc ? 1 - year : year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: 0,
  });

  // The formatter has no millisecond field, so compare against the instant
  // truncated to its second. `Math.floor` rather than trunc so that instants
  // before the epoch align downward too.
  const alignedInstant = Math.floor(instant / MS_PER_SECOND) * MS_PER_SECOND;

  return civil - alignedInstant;
}

const validityCache = new Map<string, boolean>();

/** Whether the host's timezone database recognises `zone`. */
export function isValidTimezone(zone: string): boolean {
  const cached = validityCache.get(zone);

  if (cached !== undefined) {
    return cached;
  }

  let valid: boolean;
  try {
    offsetFor(zone, Date.now());
    valid = true;
  } catch {
    valid = false;
  }

  validityCache.set(zone, valid);

  return valid;
}

/** Throws `InvalidTimezoneError` unless `zone` is recognised. */
export function assertValidTimezone(zone: string): TimezoneIdentifier {
  if (!isValidTimezone(zone)) {
    throw new InvalidTimezoneError(zone);
  }

  return zone;
}

/** The host's own timezone, used as the default when none is configured. */
export function systemTimezone(): TimezoneIdentifier {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The wall-clock reading of `instant` in `zone`, as civil milliseconds. */
export function civilMsFromInstant(zone: TimezoneIdentifier, instant: number): number {
  return instant + offsetFor(zone, instant);
}

/** The wall-clock reading of `instant` in `zone`, as components. */
export function componentsFromInstant(
  zone: TimezoneIdentifier,
  instant: number,
): DateTimeComponents {
  return decodeCivil(civilMsFromInstant(zone, instant));
}

/**
 * Resolve a wall-clock reading in `zone` to an instant.
 *
 * The algorithm is a candidate-and-verify search rather than the tempting
 * "subtract the offset" one-liner, because the offset you'd subtract is the
 * offset *at the answer you don't have yet*. Concretely: 02:30 on a
 * US spring-forward date reads back an offset of UTC-4, and naively
 * subtracting it produces 06:30 local — a time the caller never asked for,
 * with no error raised.
 *
 * So: probe the offsets in force a day either side (a 48-hour window
 * straddles any single transition), treat each distinct offset as a
 * candidate, and keep only those that actually round-trip back to the
 * requested wall clock. Zero survivors means a gap, two means an overlap.
 */
export function instantFromComponents(
  zone: TimezoneIdentifier,
  components: DateTimeComponents,
  disambiguation: Disambiguation = "compatible",
): number {
  return instantFromCivilMs(zone, encodeCivil(components), disambiguation);
}

/** As `instantFromComponents`, but taking pre-encoded civil milliseconds. */
export function instantFromCivilMs(
  zone: TimezoneIdentifier,
  civilMs: number,
  disambiguation: Disambiguation = "compatible",
): number {
  const probes = new Set([
    offsetFor(zone, civilMs - MS_PER_DAY),
    offsetFor(zone, civilMs),
    offsetFor(zone, civilMs + MS_PER_DAY),
  ]);

  const valid: number[] = [];

  for (const offset of probes) {
    const candidate = civilMs - offset;

    // Round-trip: the candidate is only real if the zone actually uses this
    // offset at that instant. `candidate + offset === civilMs` by
    // construction, so verifying the offset verifies the wall clock.
    if (offsetFor(zone, candidate) === offset) {
      valid.push(candidate);
    }
  }

  if (valid.length === 1) {
    return valid[0]!;
  }

  if (valid.length > 1) {
    return resolveOverlap(zone, civilMs, valid, disambiguation);
  }

  return resolveGap(zone, civilMs, [...probes], disambiguation);
}

/** The wall clock happens twice; pick one. */
function resolveOverlap(
  zone: TimezoneIdentifier,
  civilMs: number,
  candidates: number[],
  disambiguation: Disambiguation,
): number {
  const earliest = Math.min(...candidates);
  const latest = Math.max(...candidates);

  switch (disambiguation) {
    case "later":
      return latest;
    case "reject":
      throw new AmbiguousTimeError(
        "ambiguous",
        `${describeCivil(civilMs)} occurs twice in ${zone} (a daylight-saving ` +
          `fall-back). Pass disambiguation: "earlier" or "later" to choose.`,
      );
    // "compatible" matches Carbon and Temporal: the first occurrence wins.
    case "compatible":
    case "earlier":
      return earliest;
  }
}

/** The wall clock never happens; shift out of the gap. */
function resolveGap(
  zone: TimezoneIdentifier,
  civilMs: number,
  offsets: number[],
  disambiguation: Disambiguation,
): number {
  const offsetBefore = Math.min(...offsets);
  const offsetAfter = Math.max(...offsets);

  if (disambiguation === "reject") {
    const gapMinutes = (offsetAfter - offsetBefore) / 60_000;
    throw new AmbiguousTimeError(
      "nonexistent",
      `${describeCivil(civilMs)} does not exist in ${zone}: the clock jumps ` +
        `forward ${gapMinutes} minutes at that point. Pass disambiguation: ` +
        `"earlier" or "later" to shift out of the gap.`,
    );
  }

  // Subtracting the *pre*-transition offset lands after the gap (02:30 →
  // 03:30); subtracting the post-transition offset lands before it
  // (02:30 → 01:30). "compatible" shifts forward, as Temporal does.
  return disambiguation === "earlier" ? civilMs - offsetAfter : civilMs - offsetBefore;
}

function describeCivil(civilMs: number): string {
  return new Date(civilMs).toISOString().replace("T", " ").replace(".000Z", "");
}
