/**
 * Parser and matcher for the classic 5-field cron expression
 * (`minute hour day-of-month month day-of-week`).
 *
 * An expression is **parsed once, eagerly**, `parseCronExpression()`
 * turns it into a `CompiledCron` (a `Set` of matching values per field)
 * and throws `InvalidCronExpressionError` on anything it can't make sense
 * of. That timing is the whole point: `ScheduledTask.cron()` compiles at
 * registration, so a typo in an expression is a boot-time error naming the
 * offending field rather than a throw from inside `schedule:run` an hour
 * later, where it would abort every other due task with it.
 *
 * Supported vocabulary, per comma-separated component of a field (the
 * step wildcard is written here as `* + /n` only because a literal
 * asterisk-slash would end this comment):
 *
 * | Form | Example | Meaning |
 * |---|---|---|
 * | `*` | `*` | Any value. |
 * | `?` | `?` | Any value (day fields only, Quartz spelling of `*`). |
 * | `* + /n` | every 5th minute | Every nth from the field's minimum. |
 * | `a-b` | `9-17` | Inclusive range. |
 * | `a-b/n` | `0-30/10` | Every nth within the range. |
 * | `a/n` | `5/15` | Every nth from `a` to the field's maximum. |
 * | `n` | `15` | Exactly that value. |
 * | names | `MON`, `JAN-MAR` | Case-insensitive three-letter day/month names. |
 * | `L` | `L` | Day-of-month only: the last calendar day of the month. |
 *
 * Plus the `@hourly`/`@daily`/`@midnight`/`@weekly`/`@monthly`/`@yearly`/
 * `@annually` shorthands, which expand to the equivalent 5-field form.
 *
 * Two semantics worth calling out because they are easy to get wrong:
 *
 * - **Day-of-week `7` is Sunday**, the same as `0`, matching Vixie cron.
 * - **Day-of-month and day-of-week OR when both are restricted.** `0 0 1 * 1`
 *   is "the 1st of the month *or* any Monday", not "the 1st, if it's a
 *   Monday", again matching Vixie cron (and therefore Laravel, and
 *   therefore what a `crontab` line with the same text would do). When
 *   only one of the two is restricted, it simply applies.
 *
 * Evaluation is against local server time by default; pass a `timeZone`
 * (an IANA name like `"America/New_York"`) to evaluate the wall-clock
 * fields in that zone instead. See `ScheduledTask.timezone()`.
 */

/**
 * Thrown by `parseCronExpression()`/`validateCronExpression()`, and so by
 * `ScheduledTask.cron()`, for an expression that can't be parsed.
 */
export class InvalidCronExpressionError extends Error {
  constructor(
    readonly expression: string,
    reason: string,
  ) {
    super(`Invalid cron expression "${expression}": ${reason}`);
    this.name = "InvalidCronExpressionError";
  }
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

interface FieldSpec {
  /** Human name, used in error messages. */
  label: string;
  min: number;
  max: number;
  /** Recognised three-letter names, if the field accepts any. */
  names?: Record<string, number>;
  /** Whether `?` is accepted as a synonym for `*` (the two day fields). */
  allowsAny?: boolean;
}

const MINUTE: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { label: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { label: "day-of-month", min: 1, max: 31, allowsAny: true };
const MONTH: FieldSpec = { label: "month", min: 1, max: 12, names: MONTH_NAMES };
// `max: 7` because Vixie cron accepts 7 for Sunday; it is normalised to 0
// as the field is expanded, so a compiled set never contains 7.
const DAY_OF_WEEK: FieldSpec = {
  label: "day-of-week",
  min: 0,
  max: 7,
  names: WEEKDAY_NAMES,
  allowsAny: true,
};

/** The `@shorthand` expressions, expanded to their 5-field equivalents. */
const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A field expanded to the exact set of values it matches. */
interface CompiledField {
  values: ReadonlySet<number>;
  /** False when the field was `*` (or `?`), i.e. it constrains nothing. */
  restricted: boolean;
}

/** A day-of-month field, which additionally understands the `L` token. */
interface CompiledDayOfMonth extends CompiledField {
  /** Whether `L` ("last calendar day of this month") was one of the components. */
  last: boolean;
}

/** A cron expression parsed into per-field value sets. Immutable and reusable. */
export interface CompiledCron {
  /**
   * The expression this was parsed from, normalised: `@shorthand`s
   * expanded, surrounding and repeated whitespace collapsed to single
   * spaces. This, not the caller's original text, is what
   * `ScheduledTask.getCronExpression()` reports.
   */
  readonly expression: string;
  /** `expression` split into its five fields, in cron order. */
  readonly fields: readonly [string, string, string, string, string];
  readonly minute: CompiledField;
  readonly hour: CompiledField;
  readonly dayOfMonth: CompiledDayOfMonth;
  readonly month: CompiledField;
  readonly dayOfWeek: CompiledField;
}

/** The extracted wall-clock components a cron expression is matched against. */
interface DateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0-6, Sunday = 0
  lastDayOfMonth: number; // the calendar's final day (28/29/30/31)
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Days in `month` (1-12) of `year`, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * `Intl.DateTimeFormat` construction is expensive relative to formatting,
 * and `nextRunAt()` formats up to ~500k instants in a scan, so formatters
 * are built once per zone and reused.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
}

/**
 * Extracts the wall-clock components of `date`, either in local server
 * time (default) or in the given IANA `timeZone`. Timezone extraction uses
 * `Intl.DateTimeFormat`, which every supported Node runtime ships with full
 * ICU data for.
 */
function extractParts(date: Date, timeZone?: string): DateParts {
  if (!timeZone) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month,
      dayOfWeek: date.getDay(),
      lastDayOfMonth: daysInMonth(year, month),
    };
  }

  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }

  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const weekdayValue = lookup.weekday ?? "Sun";
  const dayOfWeek = WEEKDAY_INDEX[weekdayValue] ?? 0;

  return {
    minute: Number(lookup.minute),
    hour: Number(lookup.hour),
    dayOfMonth: Number(lookup.day),
    month,
    dayOfWeek,
    lastDayOfMonth: daysInMonth(year, month),
  };
}

/**
 * Resolves one endpoint of a component: a number, or a three-letter name
 * if the field has any. Returns `undefined` when it is neither, so the
 * caller can raise an error carrying the whole expression.
 */
function resolveValue(text: string, spec: FieldSpec): number | undefined {
  if (spec.names) {
    const named = spec.names[text.toUpperCase()];

    if (named !== undefined) {
      return named;
    }
  }

  if (!/^\d+$/.test(text)) {
    return undefined;
  }

  return Number(text);
}

/**
 * Expands a single comma component into the values it matches, adding them
 * to `into`. Every failure mode throws with the field label and the
 * offending text, since these are read at registration time by whoever
 * wrote the expression.
 */
function expandComponent(
  component: string,
  spec: FieldSpec,
  into: Set<number>,
  expression: string,
): void {
  // A nested function declaration rather than a `const` arrow so TypeScript
  // treats a `fail(...)` call as unreachable-after and narrows the values
  // below to non-optional.
  function fail(reason: string): never {
    throw new InvalidCronExpressionError(expression, `${spec.label} field: ${reason}`);
  }

  const [bodyText, stepText, ...extra] = component.split("/");
  const body = bodyText ?? "";

  if (extra.length > 0) {
    fail(`"${component}" has more than one step.`);
  }

  let step = 1;

  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
      fail(`"${component}" has an invalid step — expected a positive integer after "/".`);
    }

    step = Number(stepText);
  }

  // `*` and `?` (both "any value"), with an optional step, they cover the
  // field's whole range.
  if (body === "*" || (body === "?" && spec.allowsAny)) {
    for (let value = spec.min; value <= spec.max; value += step) {
      into.add(value);
    }

    return;
  }

  if (body === "?") {
    fail(`"?" is only valid in the day-of-month and day-of-week fields.`);
  }

  // A range, with or without a step. `-` can't appear in a name, so a
  // dash anywhere means "range" unambiguously.
  const dash = body.indexOf("-");

  if (dash > 0) {
    const lowText = body.slice(0, dash);
    const highText = body.slice(dash + 1);
    const low = resolveValue(lowText, spec);
    const high = resolveValue(highText, spec);

    if (low === undefined) {
      fail(`"${lowText}" is not a valid value.`);
    }

    if (high === undefined) {
      fail(`"${highText}" is not a valid value.`);
    }

    if (low < spec.min || low > spec.max || high < spec.min || high > spec.max) {
      fail(`"${body}" is out of range — expected ${spec.min}-${spec.max}.`);
    }

    if (high < low) {
      fail(`"${body}" is an inverted range.`);
    }

    for (let value = low; value <= high; value += step) {
      into.add(value);
    }

    return;
  }

  const single = resolveValue(body, spec);

  if (single === undefined) {
    fail(`"${body}" is not a valid value.`);
  }

  if (single < spec.min || single > spec.max) {
    fail(`"${body}" is out of range — expected ${spec.min}-${spec.max}.`);
  }

  // A step on a lone number means "from here to the field's maximum",
  // matching Vixie cron: `5/15` in the minute field is 5, 20, 35, 50.
  if (stepText !== undefined) {
    for (let value = single; value <= spec.max; value += step) {
      into.add(value);
    }

    return;
  }

  into.add(single);
}

function compileField(field: string, spec: FieldSpec, expression: string): CompiledField {
  const values = new Set<number>();

  for (const component of field.split(",")) {
    if (component === "") {
      throw new InvalidCronExpressionError(
        expression,
        `${spec.label} field: "${field}" has an empty component.`,
      );
    }

    expandComponent(component, spec, values, expression);
  }

  return { values, restricted: !isUnrestricted(field, spec) };
}

/** Whether a raw field constrains nothing: `*`, `?`, or a step-less wildcard list of those. */
function isUnrestricted(field: string, spec: FieldSpec): boolean {
  return field === "*" || (spec.allowsAny === true && field === "?");
}

/** Day-of-month, which additionally accepts the `L` last-day token per component. */
function compileDayOfMonth(field: string, expression: string): CompiledDayOfMonth {
  const values = new Set<number>();
  let last = false;

  for (const component of field.split(",")) {
    if (component.toUpperCase() === "L") {
      last = true;
      continue;
    }

    if (component === "") {
      throw new InvalidCronExpressionError(
        expression,
        `day-of-month field: "${field}" has an empty component.`,
      );
    }

    expandComponent(component, DAY_OF_MONTH, values, expression);
  }

  return { values, last, restricted: !isUnrestricted(field, DAY_OF_MONTH) };
}

/**
 * Compiled expressions are cached by their source text: `nextRunAt()` and
 * `schedule:work` both match the same handful of expressions over and over,
 * and expressions come from application code, so the key space is bounded
 * by the size of the schedule. The cap is belt-and-braces for the case
 * where one is built dynamically per call.
 */
const compiled = new Map<string, CompiledCron>();
const COMPILE_CACHE_LIMIT = 500;

/**
 * Parses and validates a cron expression, returning its compiled form.
 * Throws `InvalidCronExpressionError`, with the field and the offending
 * text, for anything malformed, out of range, or unsupported.
 */
export function parseCronExpression(expression: string): CompiledCron {
  const cached = compiled.get(expression);

  if (cached) {
    return cached;
  }

  const trimmed = expression.trim();
  const expanded = trimmed.startsWith("@") ? expandAlias(expression, trimmed) : trimmed;

  const fields = expanded.split(/\s+/);

  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(expression, `expected 5 fields, got ${fields.length}.`);
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const dayOfWeek = compileField(dowField, DAY_OF_WEEK, expression);
  // Vixie cron accepts 7 for Sunday; normalise so matching only ever has
  // to consider 0-6 (which is what `Date.getDay()` produces).
  const dowValues = new Set<number>();

  for (const value of dayOfWeek.values) {
    dowValues.add(value === 7 ? 0 : value);
  }

  const result: CompiledCron = {
    expression: fields.join(" "),
    fields: [minuteField, hourField, domField, monthField, dowField],
    minute: compileField(minuteField, MINUTE, expression),
    hour: compileField(hourField, HOUR, expression),
    dayOfMonth: compileDayOfMonth(domField, expression),
    month: compileField(monthField, MONTH, expression),
    dayOfWeek: { values: dowValues, restricted: dayOfWeek.restricted },
  };

  if (compiled.size >= COMPILE_CACHE_LIMIT) {
    compiled.clear();
  }

  compiled.set(expression, result);

  return result;
}

function expandAlias(original: string, trimmed: string): string {
  const alias = ALIASES[trimmed.toLowerCase()];

  if (alias) {
    return alias;
  }

  if (trimmed.toLowerCase() === "@reboot") {
    throw new InvalidCronExpressionError(
      original,
      `"@reboot" has no meaning for a scheduler that is re-evaluated every minute — run the work at boot instead.`,
    );
  }

  throw new InvalidCronExpressionError(
    original,
    `unknown shorthand — expected one of ${Object.keys(ALIASES).join(", ")}.`,
  );
}

/**
 * Validates a cron expression, throwing `InvalidCronExpressionError` if it
 * is malformed. Kept as a named export because it reads better than
 * `parseCronExpression()` at call sites that only want the check.
 */
export function validateCronExpression(expression: string): void {
  parseCronExpression(expression);
}

/**
 * Whether a compiled expression is due at the given date (minute
 * resolution. Seconds are ignored, matching standard cron). Evaluated
 * against local server time unless `timeZone` (an IANA name) is given, in
 * which case the wall-clock fields are read in that zone.
 */
export function isCompiledCronDue(cron: CompiledCron, date: Date, timeZone?: string): boolean {
  const parts = extractParts(date, timeZone);

  if (!cron.minute.values.has(parts.minute)) {
    return false;
  }

  if (!cron.hour.values.has(parts.hour)) {
    return false;
  }

  return dayMatches(cron, parts);
}

/**
 * Whether the given cron expression is due at the given date. Compiles
 * (memoised) and matches. See `isCompiledCronDue()`.
 */
export function isCronDue(expression: string, date: Date, timeZone?: string): boolean {
  return isCompiledCronDue(parseCronExpression(expression), date, timeZone);
}

const MINUTE_MS = 60_000;

/**
 * The first instant strictly after `from` at which `cron` is due, or
 * `undefined` if there is none within `withinDays` (default ~1 year, the
 * only expressions with a longer gap are impossible ones like Feb 30).
 *
 * Scans forward in real time (`+60_000ms` per step) rather than by
 * incrementing local wall-clock minutes: around a DST fall-back the same
 * local minute occurs twice, and `setMinutes(+1)` from the second
 * occurrence walks *backwards* into the first, which can loop. Adding to
 * the timestamp visits every instant exactly once in either direction of
 * transition.
 *
 * The scan skips whole days and whole hours that can't match, so the
 * pathological case (a once-a-year expression) costs thousands of
 * iterations rather than half a million. The skips deliberately stop an
 * hour short of the boundary they aim at, so a DST shift can never make
 * one jump over a matching minute.
 */
export function nextCronRun(
  cron: CompiledCron,
  from: Date,
  timeZone?: string,
  withinDays = 366,
): Date | undefined {
  // Start at the top of the minute after `from`, so "next" is always
  // strictly in the future and always minute-aligned.
  let cursor = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const deadline = cursor + withinDays * 24 * 60 * MINUTE_MS;

  while (cursor <= deadline) {
    const date = new Date(cursor);
    const parts = extractParts(date, timeZone);

    if (!dayMatches(cron, parts)) {
      // Jump towards the start of the next day, less an hour of slack for
      // a possible DST shift in between.
      const minutesLeftInDay = 24 * 60 - (parts.hour * 60 + parts.minute);
      cursor += Math.max(1, minutesLeftInDay - 60) * MINUTE_MS;
      continue;
    }

    if (!cron.hour.values.has(parts.hour)) {
      cursor += (60 - parts.minute) * MINUTE_MS;
      continue;
    }

    if (cron.minute.values.has(parts.minute)) {
      return date;
    }

    cursor += MINUTE_MS;
  }

  return undefined;
}

/**
 * The month / day-of-month / day-of-week half of a match, split out
 * because `nextCronRun()` uses it alone to decide whether a whole day can
 * be skipped.
 *
 * Vixie cron: when BOTH day fields are restricted they are OR-ed, so
 * `0 0 1 * 1` fires on the 1st AND on every Monday. When only one is
 * restricted the other matches everything, and OR would then make the
 * expression match every day, hence the explicit branch rather than a
 * uniform `||`.
 */
function dayMatches(cron: CompiledCron, parts: DateParts): boolean {
  if (!cron.month.values.has(parts.month)) {
    return false;
  }

  const domMatches =
    cron.dayOfMonth.values.has(parts.dayOfMonth) ||
    (cron.dayOfMonth.last && parts.dayOfMonth === parts.lastDayOfMonth);
  const dowMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);

  if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) {
    return domMatches || dowMatches;
  }

  return domMatches && dowMatches;
}
