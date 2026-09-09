/**
 * Every error this package throws descends from `DateTimeError`, so callers
 * can catch the whole family with one `instanceof` check without also
 * swallowing unrelated `TypeError`s.
 *
 * The rule for which methods throw and which return `null`:
 *
 * - Methods named `parse`, `create`, `from*` **throw**. They are the
 *   authoritative constructors; a caller that hands them garbage has a bug,
 *   and silently producing an "Invalid Date"-style poisoned object (the
 *   native `Date` mistake) makes that bug surface somewhere far away.
 * - Methods suffixed `Safe` (`createSafe`, `parseSafe`) **return `null`**.
 *   Use those when the input is genuinely untrusted (user input, an HTTP
 *   payload) and a failure is an expected branch rather than a bug.
 *
 * There is deliberately no third "invalid DateTime" state. A `DateTime`
 * instance is always a valid instant.
 */

export class DateTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The requested instant could not be constructed from the given input. */
export class InvalidDateTimeError extends DateTimeError {}

/** The timezone identifier is not recognised by the host's IANA database. */
export class InvalidTimezoneError extends DateTimeError {
  constructor(timezone: string) {
    super(
      `Unknown timezone "${timezone}". Expected an IANA identifier such as ` +
        `"UTC" or "Australia/Perth", or a fixed offset such as "+08:00".`,
    );
  }
}

/** A string did not match the format it was required to match. */
export class InvalidFormatError extends DateTimeError {}

/** A `Duration` was constructed from, or asked for, something incoherent. */
export class InvalidDurationError extends DateTimeError {}

/** An `Interval` was constructed with an end that precedes its start. */
export class InvalidIntervalError extends DateTimeError {}

/**
 * A local wall-clock time was resolved against a timezone under the
 * `"reject"` disambiguation policy, and that local time either does not
 * exist (spring forward) or exists twice (fall back).
 *
 * @see Disambiguation
 */
export class AmbiguousTimeError extends DateTimeError {
  constructor(
    readonly kind: "ambiguous" | "nonexistent",
    message: string,
  ) {
    super(message);
  }
}
