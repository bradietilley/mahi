# Dates & times

`@mahiframework/datetime` is an immutable, timezone-aware temporal model with a
Carbon-inspired API. It is the type every framework timestamp flows
through: model `created_at`/`updated_at` columns, token expiries, queue
`available_at` stamps, session TTLs, and soft-delete markers are all
`DateTime` values under the hood.

```ts
import { DateTime, Duration, Interval, Period } from "@mahiframework/datetime";

const expires = DateTime.now().addDays(7).endOfDay();
const perth = DateTime.now().inTimezone("Australia/Perth");
const age = birthday.diffInYears(DateTime.now());
```

Four things are modelled, and the package refuses to blur them:

| Type | Models | Bounds |
|---|---|---|
| `DateTime` | an **instant**, plus the zone it should be read in | — |
| `Duration` | a **length** of time, in three independent buckets | — |
| `Interval` | a **span** between two instants | half-open `[start, end)` |
| `Period` | a **sequence** of instants | inclusive both ends |

Plus `Timezone` and `Locale`, two function namespaces over host data.

It has three runtime dependencies (`date-fns`, `date-fns-tz`,
`@date-fns/utc`), and none of their types appear in any public signature —
the implementation library can be swapped without a breaking change.
Localization and relative time delegate to the host's `Intl`, so a
`small-icu` Node build will not have full locale coverage.

## `DateTime`

### The model: an instant plus a display zone

A `DateTime` is an absolute instant — milliseconds since the Unix epoch —
together with an IANA identifier saying which clock to read it on:

```ts
private constructor(
  readonly epochMilliseconds: number,
  readonly timezone: TimezoneIdentifier,
) { /* ... */ }
```

Two `DateTime`s at the same instant in different zones are **equal as
instants** but have different wall-clock readings:

```ts
const perth = DateTime.parse("2026-08-20T09:00", "Australia/Perth");
const sydney = perth.inTimezone("Australia/Sydney");

sydney.hour;              // 11
sydney.isEqual(perth);    // true  — same moment
sydney.isIdentical(perth); // false — different zone
```

That one decision explains most of the API, including why timezone
conversion and wall-clock preservation are separate methods, why exact and
calendar arithmetic behave differently across a DST boundary, and why
`isSameDay()` is not symmetric across zones.

Precision is milliseconds. There is no separate date-only type; a date is
an instant at the start of a day in a zone.

### Immutability

Every instance is `Object.freeze`d in its constructor, and every operation
returns a new one. Nothing on the class mutates.

```ts
const original = DateTime.parse("2026-01-01");
const result = original.addDays(1);

original.day;   // 1
result.day;     // 2
```

The same holds for `Duration`, `Interval`, and `Period`.

Because instances are frozen, they cannot hold a lazily-populated cache
field. Derived wall-clock values are memoised in two module-level
`WeakMap`s keyed on the instance instead, so repeated `.hour`/`.month`
reads don't re-run `Intl` lookups and entries die with their `DateTime`.

### Construction

```ts
DateTime.now();                     // this instant
DateTime.today();                   // midnight today
DateTime.yesterday();
DateTime.tomorrow();

DateTime.create(2026, 8, 20, 14, 30);      // months are 1-based
DateTime.createSafe(2026, 2, 30);           // → null, not 2 March
DateTime.createMidnightDate(2026, 8, 20);
DateTime.createFromTime(14, 30);            // today at 14:30

DateTime.fromTimestamp(1787236200000);      // milliseconds
DateTime.fromUnixTimestamp(1787236200);     // seconds
DateTime.fromDate(new Date());
DateTime.fromComponents({ year: 2026, month: 8, day: 20, hour: 0, minute: 0, second: 0, millisecond: 0 });

DateTime.fromISO("2026-08-20T14:30:00Z");
DateTime.fromRFC3339("2026-08-20T14:30:00+08:00");
DateTime.parse("2026-08-20 14:30", "Australia/Perth");
DateTime.parseSafe(untrustedInput);
DateTime.createFromFormat("20/08/2026", "dd/MM/yyyy");
```

Carbon's own spellings exist for migration: `createFromTimestamp()`
(seconds), `createFromTimestampMs()`, `createFromDate()`,
`createFromTime()`, `instance()`.

**Every factory takes an optional timezone as its last positional
argument.** Without one, the configured default is used — see
[Configuration](#configuration).

**Months are 1-based everywhere.** `DateTime.create(2026, 8, 20)` is
August. The zero-indexed month is the most common date bug in JavaScript
and this package does not reproduce it.

**Strict by default.** `create()` and `parse()` throw on input they cannot
represent; `createSafe()` and `parseSafe()` return `null`. There is no
"Invalid DateTime" state to leak into your application:

```ts
DateTime.create(2026, 2, 30);        // throws InvalidDateTimeError
DateTime.createSafe(2026, 2, 30);    // null
```

One factory keeps a Carbon surprise on purpose:
**`createFromDate(y, m, d)` returns that date at the *current time of
day*, not midnight.** It's `DateTime.now(zone).with({ year, month, day })`.
Prefer `createMidnightDate()`, whose name says what it does.

The private constructor also validates at runtime, not only in the type
system:

```ts
if (!Number.isFinite(epochMilliseconds)) {
  throw new InvalidDateTimeError(/* ... */);
}
```

TypeScript's `private` is erased, so plain JavaScript can reach the
constructor. A "a `DateTime` is always a valid instant" claim that only
held for TypeScript callers wouldn't be much of a claim.

### Parsing

Only unambiguous formats are accepted.

```ts
DateTime.parse("2026-08-20");            // ISO date
DateTime.parse("2026-08-20T14:30:00Z");  // ISO with offset
DateTime.parse("2026-08-20 14:30:00");   // database style
DateTime.parse(1787236200000);           // timestamp
DateTime.parse(new Date());              // native Date
DateTime.parse(existingDateTime);        // passthrough (re-zoned if a zone is given)

DateTime.parse("03/04/2026");            // throws — March or April?
DateTime.createFromFormat("03/04/2026", "dd/MM/yyyy");   // 3 April, unambiguously
```

The refusal to guess is deliberate. Locale-sniffing parsers are a reliable
source of production incidents — the same string means different days on
different machines — and `createFromFormat()` exists for when the caller
genuinely knows the layout.

**Offset-bearing strings determine the instant; `zone` only decides the
display.** If the string has no offset, the wall clock is interpreted *in*
`zone`:

```ts
// The string says UTC. Perth is only how we read it back.
DateTime.parse("2026-08-20T06:30:00Z", "Australia/Perth").hour;  // 14

// No offset — 14:30 IS Perth time.
DateTime.parse("2026-08-20 14:30", "Australia/Perth").hour;      // 14
```

`createFromFormat()` is **strict by default**: the parsed value must
re-format to exactly the input, which rejects things like `"2026-02-31"`
that a lenient parser would quietly correct. Pass `{ strict: false }` to
allow it. Fields the pattern doesn't mention default to today at midnight
in `zone`, so `createFromFormat("14:30", "HH:mm")` means half past two
*today*.

### Timezones

These are the two operations people conflate, and conflating them is *the*
timezone bug:

```ts
const perth = DateTime.parse("2026-08-20T09:00", "Australia/Perth");

perth.inTimezone("Australia/Sydney").hour;          // 11
perth.inTimezone("Australia/Sydney").isEqual(perth); // true  — same instant

perth.keepLocalTime("Australia/Sydney").hour;          // 9
perth.keepLocalTime("Australia/Sydney").isEqual(perth); // false — different instant
```

| You want | Use | Because |
|---|---|---|
| "What time was this log line locally?" | `inTimezone()` | The moment is fixed; only the clock changes. |
| "The meeting is at 9am wherever the office is." | `keepLocalTime()` | The wall clock is fixed; the moment changes. |

`setTimezone()`, `withTimezone()`, and `toTimezone()` are all aliases of
`inTimezone()`, for Carbon's spellings. `utc()` and `local()` are
shorthands for `inTimezone("UTC")` and the host's zone.

Timezone identifiers are validated at runtime against the host's IANA
database. Unknown zones — and, importantly, **blank** ones — throw
`InvalidTimezoneError` rather than falling back to the host's zone, which
is what `Intl` would silently do.

Related accessors:

```ts
date.timezone;        // "Australia/Perth" — the readonly identifier
date.timezoneName;    // same
date.offset;          // offset from UTC, in milliseconds
date.offsetMinutes;
date.offsetHours;
date.isDST();         // is this zone observing DST at this instant?
```

### DST behaviour

A wall-clock time may map to **zero** instants (a spring-forward gap) or
**two** (a fall-back overlap). The package never guesses silently; the
policy is an explicit `disambiguation` option:

```ts
DateTime.parse("2026-03-08T02:30", "America/New_York", {
  disambiguation: "reject",   // throws AmbiguousTimeError — that time never happens
});
```

| Policy | Gap (time doesn't exist) | Overlap (time happens twice) |
|---|---|---|
| `"compatible"` *(default)* | Shift forward: 02:30 → 03:30 | First occurrence |
| `"earlier"` | Shift backward: 02:30 → 01:30 | First occurrence |
| `"later"` | Shift forward: 02:30 → 03:30 | Second occurrence |
| `"reject"` | Throws `AmbiguousTimeError` | Throws `AmbiguousTimeError` |

Use `"reject"` for billing, scheduling, and anything where a silent
one-hour slip is worse than a loud failure. `AmbiguousTimeError` carries a
`kind` of `"ambiguous"` or `"nonexistent"` so a handler can tell which
case it hit.

Boundary methods pick sensibly on your behalf. `startOf()` uses
`"compatible"` — so a day with no midnight (São Paulo used to change
clocks at midnight) starts at the first instant that *does* exist, rather
than shifting backwards into the previous day. `endOf()` resolves
ambiguity to `"later"`, so the end of a fall-back day really is the end of
it.

Every calendar operation funnels through one private
`withCivilMs(civilMs, disambiguation)`, which is what makes DST handling
uniform: there is exactly one place where a wall clock becomes an instant.

### Getters

```ts
date.year;  date.month;  date.day;  date.dayOfMonth;
date.hour;  date.minute;  date.second;  date.millisecond;

date.dayOfWeek;      // 0 = Sunday … 6 = Saturday
date.isoDayOfWeek;   // 1 = Monday … 7 = Sunday
date.dayOfYear;
date.quarter;
date.daysInMonth;  date.daysInYear;
date.week({ weekStartsOn: 0 });  date.weekYear();
date.isoWeek;  date.isoWeekYear;
date.weekOfYear;  date.weekOfMonth;
date.century;  date.age;

date.epochMilliseconds;  date.timestamp;  date.unixTimestamp;
```

`get(unit)` reads any unit by name, for code that's generic over units:

```ts
date.get("quarter");   // 3
```

### Field replacement

```ts
date.with({ hour: 9, minute: 0 });
date.withYear(2027);  date.withMonth(1);  date.withDay(1);
date.withHour(9);  date.withMinute(0);  date.withSecond(0);  date.withMillisecond(0);

date.setDate(2026, 8, 20);        // calendar date, keeping time of day
date.setTime(14, 30);              // time of day, keeping the date
date.setUnit("hour", 9);           // any single field by name
```

`with()` merges over the current components, validates the result, and
re-resolves against the zone — so replacing the hour on a transition date
behaves like any other calendar operation. Out-of-range components throw.

### Arithmetic

```ts
date.addDays(3).subHours(2);
date.add(Duration.days(2).addHours(4));
date.subtract({ months: 1, days: 3 });
date.addUnit("quarter", 2);
date.subUnit("week", 1);
date.addDay();                     // singular aliases exist for every unit
```

Two families, deliberately different:

- **Exact** (`addMilliseconds`, `addSeconds`, `addMinutes`, `addHours`)
  moves the **instant**. A day is never assumed to be 24 hours.
- **Calendar** (`addDays` and above) moves the **wall clock** and
  re-resolves against the zone.

Across a US spring-forward, `addDays(1)` advances 23 real hours and
`addHours(24)` advances 24. Both are correct; they answer different
questions.

**Month arithmetic clamps.** 31 January plus one month is 28/29 February:

```ts
DateTime.create(2026, 1, 31).addMonths(1).toISODate();   // "2026-02-28"
```

This is deliberately not reversible — `addMonths(1).subMonths(1)` on
31 January returns 28 February — and deliberately different from PHP. Every
alternative is worse. `addMonthsWithOverflow()` /
`subMonthsWithOverflow()` / `addYearsWithOverflow()` /
`subYearsWithOverflow()` reproduce PHP's spill-over behaviour (2 or
3 March) for migrations where a downstream report depends on the old
numbers.

`add(duration)` applies buckets **largest-first**: months, then days, then
exact milliseconds. That matters at month boundaries — 31 January plus
"1 month and 1 day" is 1 March (clamp to 28 Feb, then add a day), not
3 March. The order is fixed and tested rather than incidental.

### Boundaries

```ts
date.startOf("month");             // generic
date.endOf("quarter");

date.startOfDay();     date.endOfDay();
date.startOfWeek({ weekStartsOn: 0 });   date.endOfWeek();
date.startOfMonth();   date.endOfMonth();
date.startOfQuarter(); date.endOfQuarter();
date.startOfYear();    date.endOfYear();
date.startOfDecade();  date.endOfDecade();
date.startOfCentury(); date.endOfCentury();   // centuries are 1901–2000

date.floor("hour");    // == startOf
date.ceil("hour");     // next boundary, unless already exactly on one
date.round("hour");    // nearest; exact midpoints round up
```

`startOf`/`endOf` also exist for `millisecond`, `second`, `minute`, and
`hour` as named methods (`startOfSecond()`, `endOfHour()`, …).

`startOfWeek()` defaults to **Monday everywhere**, not to the host locale —
see [`Locale`](#locale) for why.

### Comparisons

```ts
a.isBefore(b);   a.isAfter(b);
a.isBeforeOrEqual(b);  a.isAfterOrEqual(b);
a.isEqual(b);          // same instant
a.isIdentical(b);      // same instant AND same zone
a.compareTo(b);        // -1 | 0 | 1
a.isBetween(start, end, { inclusive: false });

a.isSameDay(b);  a.isSameWeek(b);  a.isSameMonth(b);
a.isSameQuarter(b);  a.isSameYear(b);
a.isSame("quarter", b);
a.isSameAs("yyyy-'W'II", b);   // "same" under any format pattern you like

DateTime.min(a, b, c);
DateTime.max(a, b, c);
DateTime.average(a, b);
a.closest(b, c);   a.farthest(b, c);
a.clamp(min, max);
```

**Ordering compares instants**; zones are irrelevant. 09:00 Perth and
11:00 Sydney on the same day are the same moment and compare equal.

**Calendar comparisons use the receiver's zone.** `a.isSameDay(b)` asks
whether `b` falls on `a`'s calendar day, which makes it intentionally
non-symmetric across zones — a calendar question needs a calendar, and a
calendar needs a zone.

`clamp()` accepts its bounds in either order. `closest()`/`farthest()`
return the result **in the receiver's zone** — "which of these is nearest
to *me*" belongs on the caller's clock — and throw if given no candidates.

A large family of convenience predicates:

```ts
date.isPast();  date.isFuture();
date.isToday();  date.isTomorrow();  date.isYesterday();
date.isCurrentDay();  date.isCurrentWeek();  date.isCurrentMonth();
date.isCurrentQuarter();  date.isCurrentYear();
date.isNextWeek();  date.isLastWeek();
date.isNextMonth();  date.isLastMonth();
date.isNextYear();   date.isLastYear();

date.isMonday(); /* … */ date.isSunday();
date.isWeekend();  date.isWeekday();
date.isLeapYear();  date.isLongYear();  date.isoWeeksInYear();
date.isFirstDayOfMonth();  date.isLastDayOfMonth();
date.isStartOfDay();  date.isEndOfDay();  date.isMidnight();  date.isMidday();
date.isBirthday(other?);   // same month and day, ignoring the year
```

### Navigation

```ts
date.next(5);              // next Friday (Weekday: 0 = Sunday)
date.previous(1);          // previous Monday
date.nextWeekday();  date.previousWeekday();
date.nextWeekendDay();  date.previousWeekendDay();

date.firstOfMonth(weekday?);  date.lastOfMonth(weekday?);
date.nthOfMonth(2, 2);        // 2nd Tuesday — DateTime | null
date.firstOfQuarter();  date.lastOfQuarter();  date.nthOfQuarter(n, weekday);
date.firstOfYear();     date.lastOfYear();     date.nthOfYear(n, weekday);
```

The `nthOf*` methods return `null` when the requested occurrence doesn't
exist (there is no 5th Tuesday in most months), rather than silently
rolling into the following period.

### Differences

```ts
a.diffInDays(b);                      // truncated toward zero, signed
a.diffInDays(b, { absolute: true });
a.diffInMonths(b, { float: true });
a.diff(b);                            // exact elapsed time, as a Duration
```

Available: `diffInMilliseconds`, `diffInSeconds`, `diffInMinutes`,
`diffInHours`, `diffInDays`, `diffInWeeks`, `diffInMonths`,
`diffInQuarters`, `diffInYears`.

**Hours and below measure real elapsed time. Days and above measure
wall-clock calendar distance.** Across a spring-forward, midnight to
midnight is `diffInHours() === 23` and `diffInDays() === 1`. That's not an
inconsistency — they are answers to different questions.

The sign is positive when `other` is later than the receiver.
`DiffOptions` has two flags: `absolute` (discard the sign) and `float`
(don't truncate).

**Month differences are not antisymmetric.**
`a.diffInMonths(b) !== -b.diffInMonths(a)` in general, because months
differ in length by direction. What does hold — and what is tested — is
that stepping by the whole-month count never overshoots. The
implementation counts whole units by stepping until the next step would
pass the target, then measures the fraction into the following unit;
dividing by an "average month" would break the property that 31 Jan →
28 Feb is exactly 1 month, matching what `addMonths` does.

`diff()` is always an **exact** `Duration` of milliseconds, never calendar
parts — "how long between these two moments" has one true answer.

### Relative time

```ts
date.diffForHumans();                                    // "3 days ago"
date.diffForHumans(other);                               // relative to `other`
date.fromNow();                                          // "3 days ago"
date.toNow();                                            // "in 3 days"
date.from(other);   date.to(other);

date.diffForHumans(undefined, { parts: 2 });             // "2 days, 1 hour ago"
date.diffForHumans(undefined, { short: true });          // "3d ago"
date.diffForHumans(undefined, { syntax: "plain" });      // "3 days"
date.diffForHumans(undefined, { locale: "fr" });         // "il y a 3 jours"
```

`HumanizeOptions`:

| Option | Default | Meaning |
|---|---|---|
| `parts` | `1` | How many units to render. |
| `syntax` | `"relative"` | `"relative"` gives "ago"/"in"; `"plain"` gives the bare magnitude. |
| `short` | `false` | Use the locale's abbreviated forms. |
| `locale` | configured | BCP 47 tag. |
| `justNow` | `true` | Render sub-`minimumUnit` differences as the locale's idiomatic zero. |
| `minimumUnit` | `"second"` | Smallest unit worth naming. |
| `maximumUnit` | `"year"` | Largest unit worth naming. |

Phrasing comes from the host's `Intl` data, so it's correct in every
locale the platform supports and the package ships no translated strings.
`parts > 1` needs a phrase frame derived from `Intl` at runtime; when that
derivation fails for a locale, the output falls back to a single unit
rather than emitting a half-translated string.

`justNow` tracks `minimumUnit`, so a caller working in hours gets `"this
hour"` rather than a misleadingly precise `"now"`.

**Deviation from Carbon.** Carbon renders a two-date comparison as `"3
days before"`, from bundled translations. `Intl` exposes only the
now-relative frames, so this always says "ago"/"in" relative to whatever
reference you passed. Use `syntax: "plain"` and supply your own framing if
you need "before"/"after".

### Business days

```ts
date.isBusinessDay();
date.addBusinessDays(5);
date.subBusinessDays(2);
date.nextBusinessDay();
date.previousBusinessDay();
```

Weekends are configurable, because "the weekend" is Friday–Saturday in
much of the Middle East:

```ts
date.isBusinessDay({ weekend: [5, 6] });
```

Holidays are a **predicate**, not a bundled list — this package has no
business deciding whose public holidays apply:

```ts
date.addBusinessDays(5, { isHoliday: (d) => holidays.has(d.toISODate()) });
```

### Formatting

```ts
date.format("yyyy-MM-dd HH:mm:ss");   // Unicode tokens, not PHP date() tokens
date.toISOString();     // 2026-08-20T14:30:00.000+08:00
date.toISODate();       // 2026-08-20
date.toISOTime();       // 14:30:00.000
date.toRFC3339();       // 2026-08-20T14:30:00+08:00
date.toRFC2822();
date.toDateTimeString(); // 2026-08-20 14:30:00
date.toDateString();     // 2026-08-20
date.toTimeString();     // 14:30:00.000
```

> **Format tokens are `date-fns` Unicode tokens, not PHP's.** `yyyy-MM-dd`,
> not `Y-m-d`. The two overlap enough to be confusable and differ enough to
> be dangerous — `i` means minutes in PHP and nothing in Unicode — so the
> confusable subset is rejected rather than guessed at. A bad pattern
> throws `InvalidFormatError`.

All formatting is done in the instance's own zone.

### Serialization

```ts
JSON.stringify({ at: date });   // {"at":"2026-08-20T14:30:00.000+08:00"}
date.toJSON();
date.toString();
date.toDate();          // a fresh native Date at the same instant
date.toTimestamp();     // milliseconds
date.toUnixTimestamp(); // seconds
date.toObject();        // components + timezone + offset (lossless)
date.toArray();         // [y, m, d, h, min, s, ms]
date.valueOf();         // the instant — makes <, >, and +date work
```

`toJSON()` emits an **offset-bearing** ISO string rather than a bare `Z`,
so the local wall clock survives the round trip. The IANA identifier
itself does not fit in ISO 8601 — if a consumer needs the zone *name*, use
`toObject()`.

The framework's own storage convention is different and worth knowing:
model timestamps, token expiries, and queue stamps are all written as
`DateTime.now("UTC").toISOString()`, so everything in the database is UTC
with a `+00:00` offset. Casting reads them back with
`DateTime.fromISO(value, "UTC")`. See [Models](../models/#casts).

### The test clock

```ts
DateTime.setTestNow("2026-08-20T12:00:00Z");
DateTime.hasTestNow();   // true
DateTime.setTestNow(null);  // release
```

Everything that reads the current time goes through one private
`nowInstant()`, so `now`, `today`, `isPast`, `isToday`, and
`diffForHumans` all freeze together. A clock that only half-freezes is
worse than none.

It is process-wide static state. Always release it in an `afterEach`:

```ts
afterEach(() => DateTime.setTestNow(null));
```

## `Duration`

An immutable length of time. It keeps **three independent buckets** and
never silently collapses them:

| Bucket | Meaning |
|---|---|
| `months` | Calendar-relative. Its length in milliseconds is unknowable without a start date. |
| `days` | Calendar-relative when applied to a `DateTime`; exactly 24 hours to the `total*` accessors. |
| `milliseconds` | Exact. Never depends on a calendar or a zone. |

Years and quarters are stored as months (×12, ×3); weeks are stored as
days (×7). Those conversions are exact by definition, unlike months→days.

```ts
Duration.zero();
Duration.milliseconds(500);  Duration.seconds(30);  Duration.minutes(15);
Duration.hours(2);  Duration.days(2);  Duration.weeks(3);
Duration.months(1);  Duration.quarters(2);  Duration.years(1);
Duration.from({ months: 1, days: 3, hours: 4 });
```

Composition (all returning new instances):

```ts
Duration.days(2).addHours(4).addMinutes(30);
Duration.hours(2).multiply(3);          // six hours
duration.add(other);  duration.subtract(other);
duration.negate();    duration.absolute();
duration.equals(other);
```

`addMilliseconds`/`addSeconds`/`addMinutes`/`addHours`/`addDays`/
`addWeeks`/`addMonths`/`addQuarters`/`addYears` all exist as one-liners
over `add()`.

Inspection:

```ts
duration.isZero;             // every bucket is 0
duration.isNegative;         // no bucket positive, at least one negative
duration.isExact;            // months === 0
duration.hasCalendarParts;   // months !== 0 || days !== 0
duration.toParts();          // { months, days, milliseconds }
```

Totals:

```ts
Duration.days(2).totalHours;    // 48
Duration.hours(90).totalDays;   // 3.75
Duration.months(1).totalDays;   // throws InvalidDurationError
```

**`total*` throws on a duration containing months.** There is no honest
answer — a month has no fixed number of milliseconds. The error says so
and tells you what to do instead: apply the duration to a `DateTime` and
take the difference.

`absolute()` negates each bucket independently, so a mixed-sign duration
like "+1 month, −3 days" becomes "+1 month, +3 days" rather than being
normalised. Normalising would require a reference date.

Serialization is ISO 8601 duration notation, with months preserved as `M`
in the date section rather than expanded into days — so the
calendar-relative meaning survives a round trip:

```ts
Duration.days(1).toISOString();                   // "P1D"
Duration.from({ months: 1, days: 2, hours: 3, minutes: 30 }).toISOString();
// "P1M2DT3H30M"
Duration.zero().toISOString();                    // "PT0S"
```

`date.add(Duration.days(1))` across a spring-forward advances the wall
clock by a day and the instant by 23 hours. Both are correct.

## `Interval`

A span between two instants, **half-open**: `[start, end)`.

```ts
const morning = Interval.between("2026-08-20T09:00Z", "2026-08-20T12:00Z");

morning.contains("2026-08-20T12:00Z");   // false — the end is excluded
morning.duration.totalHours;             // 3
morning.lengthMs;                        // 10800000
```

Half-open is not an arbitrary preference:

- **Adjacent intervals tile without overlapping.** `[09:00, 10:00)` and
  `[10:00, 11:00)` cover the whole two hours and share no instant, so a
  booking system built on them cannot double-book 10:00 sharp.
- **Length is exactly `end - start`**, with no off-by-one-millisecond
  correction anywhere.
- **An empty interval is expressible** (`start === end`) rather than being
  confused with a one-millisecond one.

Closed intervals force every consumer to subtract a millisecond somewhere,
and that subtraction is eventually forgotten.

### Construction

| Static | Produces |
|---|---|
| `Interval.between(start, end)` | `[start, end)`. Throws `InvalidIntervalError` if `end < start`. |
| `Interval.around(a, b)` | Same, accepting the bounds in either order. |
| `Interval.closed(start, end)` | `[start, end]`, stored as `[start, end + 1ms)`. |
| `Interval.fromDuration(start, d)` | `[start, start + d)`. |
| `Interval.endingAt(end, d)` | `[end - d, end)`. |
| `Interval.empty(instant)` | Zero-length. Contains nothing, not even `instant`. |
| `Interval.fromISOString(s, zone?)` | Parse `"<start>/<end>"`. |

`Interval.closed()` exists for the cases where an inclusive end genuinely
is what you mean. It works by extending the end by one millisecond — the
same fudge every closed-interval implementation makes, but done once,
here, where it's documented. `endInclusive` reads it back (and throws on
an empty interval, which has no inclusive end).

**The interval's zone is its start's zone.** Every `DateTime` it hands
back is read in that zone, so iterating an interval doesn't quietly change
which calendar you're on halfway through. `inTimezone(zone)` re-reads both
bounds without moving either instant.

### Relationships

```ts
morning.contains(instant);        // [start, end)
morning.encloses(other);          // other lies wholly within
morning.overlaps(afternoon);      // share at least one instant
morning.isAdjacent(afternoon);    // one begins exactly where the other ends
morning.isBefore(other);          // ends at or before other begins
morning.isAfter(other);
morning.equals(other);
morning.isEmpty;
```

**Touching intervals do not overlap.** `[09:00, 10:00)` and
`[10:00, 11:00)` are adjacent, and treating them as overlapping is exactly
the bug half-open intervals exist to prevent. An empty interval overlaps
nothing.

### Set algebra

```ts
morning.intersection(other);   // Interval | null
morning.union(other);          // Interval | null
morning.difference(lunch);     // [] | [Interval] | [Interval, Interval]
morning.gap(other);            // Interval | null
```

`union()` returns `null` for disjoint intervals rather than bridging the
gap. Returning the enclosing span for `[09:00, 10:00)` and
`[14:00, 15:00)` would silently claim the four hours in between; adjacent
intervals do unite.

`difference()` returns **zero, one, or two** intervals — punching a hole
in the middle of a span leaves two pieces, and pretending otherwise would
lose one of them.

`gap()` is the inverse of `union`'s failure case: the space between two
disjoint intervals, or `null` if they meet or overlap.

### Derivation

```ts
morning.shift(Duration.hours(1));    // move both bounds, preserving length
morning.expand(Duration.minutes(15)); // grow at both ends (negative shrinks)
morning.withStart(newStart);
morning.withEnd(newEnd);
morning.splitAt(a, b);               // tiles the original exactly
```

`splitAt()` ignores instants outside the interval, sorts the cuts, and
returns the pieces in order.

```ts
morning.toISOString();   // "<start>/<end>"
morning.toJSON();
```

## `Period`

A lazily-evaluated, iterable sequence of dates.

```ts
for (const day of Period.days("2026-08-01", "2026-08-31")) {
  // 31 midnights, in the start's zone
}
```

**Both bounds are inclusive**, unlike `Interval`. `Interval` models a
*span*, and half-open spans tile; a `Period` models a *list of dates*, and
"every day in August" plainly includes the 31st. `excludeStart()` and
`excludeEnd()` are available when they aren't wanted.

### Construction

```ts
Period.between(start, end, step = { days: 1 }, options?);
Period.recurring(start, step, count, options?);
Period.fromInterval(interval, step?, options?);

// Unit-named shorthands for `between`:
Period.milliseconds(start, end);  Period.seconds(start, end);
Period.minutes(start, end);       Period.hours(start, end);
Period.days(start, end);          Period.weeks(start, end);
Period.months(start, end);        Period.quarters(start, end);
Period.years(start, end);
```

`Period.fromInterval()` passes `excludeEnd: true` through automatically —
an `Interval` excludes its end and a `Period` includes it, and that's what
keeps the two consistent.

**Every `Period` is bounded by construction**, by an end date or a
recurrence count. There is no unbounded period, because the only thing you
can safely do with one is forget to bound it at the call site.

Two mistakes are rejected loudly rather than hanging:

```ts
Period.between(start, end, { days: -1 });   // step moves away from end → throws
Period.recurring(start, {}, 5);              // zero-length step → throws
```

### Anchored stepping

Each element is computed as `start + step × index`, **never** by
repeatedly adding to the previous element:

```ts
at(index: number): DateTime {
  return index === 0 ? this.start : this.start.add(this.step.multiply(index));
}
```

The difference shows the moment a month is involved. Anchored monthly
stepping from 31 January gives 31 Jan, 28 Feb, 31 Mar. Cumulative stepping
would clamp to the 28th in February and then *stay* there for the rest of
the year. Anchoring also makes the sequence order-independent, so `at(n)`
is O(1) and iteration cannot drift.

### Derivation and filtering

```ts
period.every(Duration.weeks(2));       // same bounds, different step
period.take(10);                       // cap the yielded count
period.until(newEnd);
period.filter((date, index) => /* … */);
period.businessDaysOnly({ weekend: [5, 6] });
period.excludeStart();
period.excludeEnd();
```

`filter()` **composes** — calling it twice requires both predicates to
pass. The index handed to the predicate counts **candidates**, not
survivors, so it stays stable as further filters are layered on.

### Evaluation

```ts
period.toArray();
period.map((d) => d.toISODate());
period.forEach(visit);
period.count();          // fully evaluates
period.first();          // DateTime | null
period.last();           // DateTime | null
period.includes(instant);
period.at(index);        // ignores filters and bounds; O(1)

period.start;  period.end;  period.step;
period.timezone;
period.recurrences;      // the element cap, or null when bounded by a date
```

`includes()` exploits monotonicity — it stops as soon as the sequence
passes the target rather than scanning to the end.

### `maxSteps`

```ts
Period.days(start, end, { maxSteps: 500_000 });
```

Iteration aborts with a clear `InvalidIntervalError` after `maxSteps`
candidates (default **100,000**). It's a safety net for two situations: a
`filter` that rejects nearly everything, and a genuinely enormous sequence
— every millisecond of a day is 86.4 million elements. Either way a hard
stop with a message beats a hung process or an exhausted heap.

Note the cap counts **candidates examined**, not elements yielded, so a
heavily-filtered period hits it sooner than its output length suggests.

```ts
Period.days("2026-08-01", "2026-08-31")
  .businessDaysOnly()
  .map((d) => d.toISODate());
```

## `Timezone`

Functions over zone identifiers. There is deliberately **no `Timezone`
class**: a zone is an identifier plus a set of rules owned by the host's
tzdata, and wrapping that in an object would only invite it to be stored,
serialised, and go stale relative to the platform. The identifier string
*is* the value.

```ts
import { Timezone } from "@mahiframework/datetime";

Timezone.system();                                  // the host's own zone
Timezone.isValid("Australia/Perth");                // boolean
Timezone.assertValid("Australia/Perth");            // the id, or throws
Timezone.offsetAt("Australia/Perth");               // ms to add to UTC, now
Timezone.offsetAt("Australia/Perth", someInstant);  // …at a given instant
Timezone.offsetMinutesAt("Australia/Perth");
Timezone.observesDST("Australia/Sydney", 2026);     // boolean
```

`observesDST()` samples January and July, which catches every zone that
observes daylight saving in either hemisphere. It is **not** a general
"has this zone ever changed its rules" test.

`TimezoneIdentifier` is `string`, not a union of every IANA zone. The zone
list is host data that changes with tzdata releases, so a hardcoded union
would be wrong the moment a country changes its rules. Validation happens
at runtime, against the host's own database.

## `Locale`

Locale data comes from `Intl`. **Nothing is bundled.**

```ts
import { Locale } from "@mahiframework/datetime";

Locale.current();                        // the configured locale
Locale.isSupported("fr-CA");
Locale.resolve("en-XX");                 // "en" — what you'd actually get
Locale.monthNames("long", "ja");
Locale.weekdayNames("short");            // index 0 = Sunday, always
Locale.firstDayOfWeek("en-US");          // 0
Locale.weekendDays("ar-EG");             // [5, 6]
Locale.ordinal(21, "en");                // "21st"
Locale.registerOrdinal("fr", (n) => (n === 1 ? "1er" : `${n}e`));
Locale.hasOrdinalRule("fr");
```

And on an instance:

```ts
date.toLocaleString({ dateStyle: "long", timeStyle: "short" }, "fr");
date.toLocaleDateString({ dateStyle: "long" });   // uses the configured locale
date.toLocaleTimeString({ timeStyle: "short" });
date.monthName("long", "fr");    // "août"
date.dayName("short");           // "Thu"
date.ordinalDay();               // "20th"
```

Carbon ships hundreds of translation files. A JavaScript package doing the
same faces a worse trade-off than a PHP one: every kilobyte is downloaded,
and "tree-shakeable locale data" survives exactly until someone writes
`locale(userPreference)`. Meanwhile every browser and every non-`small-icu`
Node build already carries CLDR. So this package is correct in every locale
the platform supports rather than in the three or four anyone would have
got round to translating, tracks the platform's CLDR updates rather than
this package's release cadence, and doesn't grow the bundle.

**Ordinal suffixes are the one thing `Intl` cannot supply**, so only
English is built in. That's a considered position rather than laziness:
ordinal suffixes are a minority feature across languages, the ones that
have them disagree about gender and agreement (French writes
"1er"/"1re"), and CLDR exposes only the plural categories the suffixes
attach to, not the suffixes themselves. Unregistered languages fall back
to the locale's plain numeral, which is what most languages use in dates
anyway. `registerOrdinal()` is keyed by primary language subtag, so
registering `"fr"` covers `"fr-CA"`.

**`Locale.firstDayOfWeek()` reports a locale's convention but is not wired
into `startOfWeek()`**, which defaults to Monday everywhere. A
locale-derived week start makes the same code produce different reports on
a developer's laptop and a production server. Pass it explicitly if you
want it:

```ts
date.startOfWeek({ weekStartsOn: Locale.firstDayOfWeek(user.locale) });
```

`firstDayOfWeek()` and `weekendDays()` read CLDR week metadata off
`Intl.Locale`, which moved from a property to a method mid-standard. All
three runtime shapes are handled — `getWeekInfo()`, `weekInfo`, and
neither — falling back to Monday and `[0, 6]` rather than assuming
whichever one your Node happens to implement.

## Configuration

```ts
import {
  setDefaultTimezone,
  setDefaultWeekStartsOn,
  setDefaultLocale,
  getDefaultTimezone,
  getDefaultWeekStartsOn,
  getDefaultLocale,
  resetDefaultTimezone,
  resetDefaultLocale,
} from "@mahiframework/datetime";

setDefaultTimezone("Australia/Perth");
setDefaultWeekStartsOn(0);
setDefaultLocale("en-AU");
```

These are process-wide mutable settings — a deliberate trade. The
alternative is threading a zone and a week-start through every call site,
and in practice an application has exactly one answer for both. Set them
once during boot, from configuration, in a service provider's `boot()`:

```ts
export class AppServiceProvider extends ServiceProvider {
  boot(): void {
    setDefaultTimezone(this.app.config.get<string>("app.timezone", "UTC"));
  }
}
```

**Nothing here affects an existing `DateTime`.** Instances capture their
zone at construction, so changing a default mid-process cannot
retroactively move an instant that already exists.

Three defaults, three different fallback policies, each for a reason:

| Setting | Default | Why |
|---|---|---|
| timezone | the host's zone, resolved **lazily on first use** | Lazy so a test setting `process.env.TZ` before touching the package still gets what it asked for. |
| week start | **Monday** (ISO 8601), never the locale | A locale-derived default would make `startOfWeek()` differ between a laptop and a server. |
| locale | the host's locale | A wrong locale produces text in an unexpected language — cosmetic and immediately visible. A wrong timezone silently produces the wrong instant. |

Server applications should still set the locale explicitly.

## Errors

Every error descends from `DateTimeError`, so one `instanceof` catches the
family without also swallowing unrelated `TypeError`s.

| Error | Raised when |
|---|---|
| `InvalidDateTimeError` | The instant cannot be constructed from the input. |
| `InvalidTimezoneError` | The zone is not in the host's IANA database (including blank). |
| `InvalidFormatError` | A string did not match its required format, or a format pattern is unusable. |
| `InvalidDurationError` | A duration was built from, or asked for, something incoherent. |
| `InvalidIntervalError` | An interval or period is malformed. |
| `AmbiguousTimeError` | A DST gap or overlap was hit under `disambiguation: "reject"`. |

The rule: **`parse`, `create`, and `from*` throw; the `*Safe` variants
return `null`.** The authoritative constructors throw because a caller
handing them garbage has a bug, and silently producing an "Invalid
Date"-style poisoned object — the native `Date` mistake — makes that bug
surface somewhere far away. Use `parseSafe`/`createSafe` for genuinely
untrusted input where failure is an expected branch:

```ts
const date = DateTime.parseSafe(request.input("due_at"));
if (date === null) {
  throw ValidationException.withMessages({ due_at: ["Not a valid date."] });
}
```

`AmbiguousTimeError` carries `kind: "ambiguous" | "nonexistent"`.
`InvalidTimezoneError` builds its own message naming the offending
identifier.

There is deliberately **no third "invalid DateTime" state**.

## Native `Date` interoperability

`Date` is an interoperability mechanism at the boundary, not the domain
model.

```ts
DateTime.fromDate(someDate);   // adopts the instant; the Date is not retained
DateTime.instance(someDate);   // Carbon's spelling of the same
date.toDate();                 // a fresh Date at the same instant
```

`valueOf()` returns the instant, so `<`, `>`, and `+date` work as
expected. `==` and `===` compare object identity, as always — use
`isEqual()` (same instant) or `isIdentical()` (same instant *and* zone).

`fromDate()` on an Invalid Date throws `InvalidDateTimeError` rather than
propagating `NaN`.

## Carbon migration

| Carbon | `DateTime` | Notes |
|---|---|---|
| `Carbon::now()` | `DateTime.now()` | |
| `Carbon::today()` | `DateTime.today()` | |
| `Carbon::parse($s)` | `DateTime.parse(s)` | Unambiguous formats only. |
| `Carbon::createFromFormat($f, $s)` | `DateTime.createFromFormat(s, f)` | **Argument order differs**; strict by default. |
| `Carbon::createFromTimestamp($t)` | `DateTime.createFromTimestamp(t)` | Seconds. `fromUnixTimestamp()` is the same. |
| `Carbon::createFromDate($y,$m,$d)` | `DateTime.createFromDate(y, m, d)` | Keeps the current *time*, as Carbon does. |
| `Carbon::instance($dt)` | `DateTime.instance(dt)` | Alias of `fromDate()`. |
| `->addMonthNoOverflow()` | `.addMonths(1)` | **This is the default here.** |
| `->addMonth()` | `.addMonthsWithOverflow(1)` | PHP overflow semantics. |
| `->format('Y-m-d')` | `.format("yyyy-MM-dd")` | Unicode tokens, not PHP tokens. |
| `->setTimezone($tz)` | `.inTimezone(tz)` | Split from `.keepLocalTime(tz)`. |
| `->isoFormat()` | `.toLocaleString()` | Via `Intl`. |
| `->locale('fr')` | `{ locale: "fr" }` per call, or `setDefaultLocale` | No mutable per-instance locale. |
| `->diffForHumans()` | `.diffForHumans()` | "ago"/"in" only. |
| `Carbon::setTestNow()` | `DateTime.setTestNow()` | |
| `CarbonInterval` | `Duration` | Three buckets. |
| `CarbonPeriod` | `Period` | Anchored stepping. |
| *(none)* | `Interval` | Half-open spans; Carbon has no equivalent. |

### Deliberate deviations

1. **Unicode format tokens**, not PHP `date()` tokens.
2. **No invalid-instance state.** Constructors throw; `*Safe` returns `null`.
3. **`parse()` refuses ambiguous layouts.** No locale-guessing of `03/04/2026`.
4. **Calendar comparisons use the receiver's zone**, and are therefore not symmetric across zones.
5. **Month differences are not antisymmetric.**
6. **`addMonths` clamps** rather than overflowing.
7. **Relative time says "ago"/"in"**, never "before"/"after".
8. **Timezone conversion and wall-clock preservation are separate methods.**

Each is pinned by a test in the package's
`tests/compatibility/carbon.test.ts`.

## Testing with dates

Freeze the clock, and always release it:

```ts
import { afterEach, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";

afterEach(() => DateTime.setTestNow(null));

it("expires a token after seven days", async () => {
  DateTime.setTestNow("2026-08-20T12:00:00Z");
  const token = await issueToken(user);

  DateTime.setTestNow("2026-08-28T12:00:00Z");
  expect(await tokenIsValid(token)).toBe(false);
});
```

`setTestNow()` affects the framework too, since model timestamps and token
expiries all read the clock through `DateTime.now()`. See
[Testing](../testing/).

The package's own suite runs under four host timezones
(`UTC`, `Australia/Perth`, `America/New_York`, `Pacific/Chatham`) because
timezone bugs love to hide behind `process.env.TZ`, and a suite that only
runs in one zone will not find them. Chatham is in the list specifically
for its 45-minute offset.

## Gotchas

**Comparing with `===`.** Use `isEqual()` (same instant) or
`isIdentical()` (same instant *and* zone).

**`createFromDate()` is not midnight.** It's that date at the current time
of day, matching Carbon. Use `createMidnightDate()`.

**`createFromFormat(input, pattern)` takes its arguments in the opposite
order to Carbon's `createFromFormat($format, $time)`.**

**Month arithmetic isn't reversible.** `addMonths(1).subMonths(1)` on 31
January returns 28 February. That's the cost of clamping, and every
alternative is worse.

**A day is not 24 hours.** `addDays(1)` is a calendar day; `addHours(24)`
is 24 hours. Across a DST transition they differ.

**`diffInMonths()` is not antisymmetric.** `a.diffInMonths(b)` is not
always `-b.diffInMonths(a)`.

**`setTimezone()` is `inTimezone()`, not `keepLocalTime()`.** The alias
exists for Carbon parity and is the classic timezone bug waiting to
happen.

**`startOfWeek()` defaults to Monday everywhere**, not to the user's
locale. Pass `weekStartsOn` explicitly, optionally from
`Locale.firstDayOfWeek()`.

**A blank timezone throws.** On purpose. `Intl` would have substituted the
host's zone and produced different results on every machine.

**`Duration.months(1).totalDays` throws.** So does every other `total*` on
a duration containing months.

**`Interval.contains(interval.end)` is `false`.** The end is excluded. Use
`Interval.closed()` if you meant an inclusive end.

**Adjacent intervals don't overlap.** `overlaps()` is strict; use
`isAdjacent()` to detect touching.

**`Period` includes both bounds; `Interval` excludes its end.** They model
different things. `Period.fromInterval()` bridges them correctly.

**`Period` iteration throws after `maxSteps` candidates**, counting
rejected ones. A heavy `filter()` hits the cap sooner than the output
length suggests.

**`toJSON()` keeps the offset, not the IANA name.** Use `toObject()` if
you need the zone name back.

**`DateTime.setTestNow()` is process-wide static state.** Release it in an
`afterEach`.

**Format tokens are Unicode, not PHP.** `yyyy-MM-dd`, not `Y-m-d`. A bad
pattern throws `InvalidFormatError`.

## Related

- [Models](../models/) — timestamp columns, date casts, soft deletes
- [Queues](../queues/) — `available_at`, delays, `retryUntil()`
- [Scheduling](../scheduling/) — cron expressions and task timezones
- [Authentication](../authentication/) — token and session expiry
- [Testing](../testing/) — freezing the clock in a test suite
- [Helpers](../helpers/) — `Str`, `Arr`, `Collection`, `Number`
