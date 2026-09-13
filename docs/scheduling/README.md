# Scheduling

Recurring work is declared in code, in a provider's `schedule()` hook, and
evaluated by a single `./artisan schedule:run` that a real crontab fires
once a minute.

```ts
export class UsersServiceProvider extends ServiceProvider {
  schedule(schedule: Schedule): void {
    schedule
      .call(async (app) => {
        await new AuthGcCommand(app).handle();
      })
      .daily()
      .name("auth-gc")
      .withoutOverlapping();
  }
}
```

One crontab entry, however many tasks. The scheduler's job is to answer
"which of these is due right now", everything else stays in your
codebase, under version control, in TypeScript.

## `Schedule`

Registered as a singleton at `SCHEDULE_TOKEN`. `ScheduleServiceProvider.boot()`
walks every provider's `schedule()` hook and hands each one the same
registry. See [Providers](../providers/).

| Method | Returns | Purpose |
|---|---|---|
| `call(callback)` | `ScheduledTask` | Register a callback task. |
| `job(factory)` | `ScheduledTask` | Register a task that dispatches a queued job. |
| `dueTasks(at = new Date(), errors?)` | `ScheduledTask[]` | Tasks due at that instant. |
| `all()` | `readonly ScheduledTask[]` | Everything registered. |
| `validate()` | `void` | Throw if the schedule is misconfigured. Called at boot. |

### `call(callback)`

```ts
type TaskCallback = (app: Application) => void | Promise<void>;
```

The callback receives the `Application`, so it can resolve whatever it
needs without closing over anything:

```ts
schedule
  .call(async (app) => {
    const db = app.make<DatabaseManager>(DATABASE_TOKEN);
    await db.driver().kysely.deleteFrom("sessions").where("expires_at", "<", now).execute();
  })
  .hourly()
  .name("prune-sessions");
```

### `job(factory)`: and why it takes a factory

```ts
schedule.job(() => new PruneStalePostsJob()).daily();
```

**A factory, not an instance.**

A schedule is built **once**, during boot, and then lives for the life of
the process (or, for `schedule:run`, is rebuilt every minute in a fresh
process, but for `schedule:work` it genuinely persists). Passing a single
instance would mean every tick dispatches *that same object*, with fields
frozen at schedule-definition time. A job constructed with a model loaded
during boot would carry that stale row forever; a job carrying a
"generated at" timestamp would report the boot time on every run.

The factory runs on each tick, so each dispatch gets a fresh job built
from current state.

`job()` is a thin wrapper over `call()`:

```ts
job(factory: () => JobLike): ScheduledTask {
  return this.call(async (app) => {
    if (!app.has(QUEUE_TOKEN)) {
      throw new Error(`schedule.job() requires @mahiframework/queue's QueueServiceProvider to be registered.`);
    }
    const queue = app.make<QueueManagerLike>(QUEUE_TOKEN);
    await queue.dispatch(factory());
  }).withDefaultName(() => probeJobName(factory));
}
```

Two things follow. First, `@mahiframework/schedule` has **no compile-time
dependency on `@mahiframework/queue`**. It resolves the string `QUEUE_TOKEN`
and types the result structurally. Register the schedule provider without
the queue package and everything except `.job()` works; call `.job()` and
you get a clear error rather than an unresolved-token failure.

Second, the task **defaults to the job class's name**:

```ts
schedule.job(() => new PruneStalePostsJob()).daily();
// name → "PruneStalePostsJob"
```

That default is derived lazily, the first time anything reads the name,
by building one job purely to read its constructor. Calling `name()`
yourself skips the probe entirely, and a factory that throws while being
probed leaves the task unnamed rather than breaking boot.

A factory returning an object literal has no class name to borrow, so it
stays unnamed and falls back to its cron expression in `schedule:list`.
Name those explicitly:

```ts
schedule.job(() => ({ handle: () => sync() })).daily().name("sync-feed");
```

**`.job()` dispatches, it does not run.** The task's work is a `push()`;
the job itself runs whenever a worker picks it up. Under the `sync`
connection those are the same moment. See [Queues](../queues/).

## `ScheduledTask`

A callback plus a 5-field cron expression, built fluently. The fields
start at `["*", "*", "*", "*", "*"]` and each helper **splices one
position**, leaving the others alone. Which is what makes composition
work:

```ts
schedule.call(sendDigest).dailyAt("9:00").weekdays();
// dailyAt sets minute+hour → "0 9 * * *"
// weekdays sets day-of-week → "0 9 * * 1,2,3,4,5"
```

### Minute frequencies

| Method | Cron minute field |
|---|---|
| `everyMinute()` | `*` |
| `everyTwoMinutes()` | `*/2` |
| `everyThreeMinutes()` | `*/3` |
| `everyFourMinutes()` | `*/4` |
| `everyFiveMinutes()` | `*/5` |
| `everyTenMinutes()` | `*/10` |
| `everyFifteenMinutes()` | `*/15` |
| `everyThirtyMinutes()` | `*/30` |

Each sets **only** the minute field. `everyFiveMinutes()` on a fresh task
gives `*/5 * * * *`.

### Hourly

| Method | Effect |
|---|---|
| `hourly()` | minute `0` |
| `hourlyAt(offset)` | minute `offset` |
| `everyTwoHours()` | minute `0`, hour `*/2` |
| `everyThreeHours()` | minute `0`, hour `*/3` |
| `everyFourHours()` | minute `0`, hour `*/4` |
| `everySixHours()` | minute `0`, hour `*/6` |

`hourlyAt(offset)` validates `0-59`:

```
Invalid minute offset "75" passed to hourlyAt() — expected 0-59.
```

Note `hourlyAt()` and `hourly()` both touch only the minute field, so
`daily().hourlyAt(30)` gives `30 0 * * *`, half past midnight, not half
past every hour. Order matters; the last call to touch a field wins.

### Daily

| Method | Effect |
|---|---|
| `daily()` | minute `0`, hour `0` |
| `dailyAt(time)` | minute + hour from `"HH:MM"` |
| `at(time)` | Alias for `dailyAt()`. |

`time` is 24-hour `"HH:MM"` or `"H:M"`, `"9:00"` and `"09:00"` both work.
Validation:

```
Invalid time "9am" — expected "HH:MM".
Invalid time "25:00" — hour must be 0-23 and minute 0-59.
```

### Weekly and named days

| Method | Effect |
|---|---|
| `weekly()` | `daily()` + day-of-week `0` (Sunday midnight) |
| `weeklyOn(dayOfWeek, time = "0:0")` | `dailyAt(time)` + that day |
| `weekdays()` | day-of-week `1,2,3,4,5` |
| `weekends()` | day-of-week `0,6` |
| `sundays()` … `saturdays()` | day-of-week `0` … `6` |

`weeklyOn()` validates `0-6`:

```
Invalid dayOfWeek "7" passed to weeklyOn() — expected 0 (Sun) - 6 (Sat).
```

**Day 0 is Sunday.** Standard cron, and the reason `weekdays()` is
`1,2,3,4,5`.

The named-day helpers set **only** day-of-week, so they compose with a
time helper:

```ts
schedule.call(sendWeeklyReport).dailyAt("8:00").mondays();   // 0 8 * * 1
```

### Monthly

| Method | Effect |
|---|---|
| `monthly()` | `daily()` + day-of-month `1` |
| `monthlyOn(dayOfMonth, time = "0:0")` | `dailyAt(time)` + that day |
| `lastDayOfMonth(time = "0:0")` | `dailyAt(time)` + day-of-month `L` |

`monthlyOn()` validates `1-31`:

```
Invalid dayOfMonth "32" passed to monthlyOn() — expected 1-31.
```

`monthlyOn(31)` simply doesn't fire in February, April, June, September or
November. The day never matches. `lastDayOfMonth()` is the fix, and uses
the `L` token so it lands on the 28th, 29th, 30th or 31st as appropriate.

```ts
schedule.call(closeBooks).lastDayOfMonth("23:30").name("close-books");
```

### `cron(expression)`

The escape hatch for anything the helpers can't express.

```ts
schedule.call(oddSchedule).cron("15,45 9-17 * * MON-FRI");
schedule.call(nightly).cron("@daily");
```

**It replaces all five fields at once**, unlike every other helper. Any
splicing done before it is discarded.

**The expression is fully validated here**, at registration, not at match
time. Errors name the field and the offending text:

```
Invalid cron expression "99 * * * *": minute field: "99" is out of range — expected 0-59.
Invalid cron expression "0 0 * * NOPE": day-of-week field: "NOPE" is not a valid value.
Invalid cron expression "5-1 * * * *": minute field: "5-1" is an inverted range.
Invalid cron expression "*/5 * *": expected 5 fields, got 3.
```

That timing is the point. These used to throw from inside `schedule:run`,
where one bad expression aborted **every** due task and crashed
`schedule:work`. Now a typo stops the app booting, next to the code that
caused it.

An `@shorthand` is expanded here too, so `getCronExpression()` reports the
five-field form:

```ts
schedule.call(nightly).cron("@daily").getCronExpression(); // "0 0 * * *"
```

### `timezone(zone)`

```ts
schedule.call(sendDigest).dailyAt("9:00").timezone("America/New_York");
```

Evaluates the cron fields against that IANA zone rather than local server
time. `getTimezone()` reads it back.

Extraction uses `Intl.DateTimeFormat` with `hourCycle: "h23"`, which every
supported Node runtime ships full ICU data for. DST is handled by `Intl`,
which means the usual DST caveats apply: a task scheduled for 02:30 local
doesn't fire on the spring-forward day (that wall-clock minute never
exists), and fires twice on the fall-back day (it happens twice). If
that's unacceptable, schedule in UTC.

### Filters: `when()` and `skip()`

```ts
type FilterCallback = (app: Application) => boolean | Promise<boolean>;
```

| Method | Semantics |
|---|---|
| `when(cb)` | Run only if truthy. Multiple `when`s are **AND**-ed. |
| `skip(cb)` | Skip if truthy. Multiple `skip`s are **OR**-ed. |
| `filtersPass(app)` | Evaluates all of them. |

```ts
schedule
  .call(syncExternalFeed)
  .everyFifteenMinutes()
  .when((app) => app.config.get<boolean>("features.feedSync", false))
  .skip(() => isMaintenanceWindow());
```

`filtersPass()` short-circuits: the first failing `when` or the first
truthy `skip` returns `false` without evaluating the rest.

Filters run **before** the overlap lock is taken. See
[`runDueTasks`](#runduetasks). A filtered-out task never "ran", so it
never touches a lock file.

### Webhook pings

All four take a URL and issue a plain `fetch(url, { method: "GET" })`.
Each is additive, call it more than once for more than one URL.

| Method | Fires |
|---|---|
| `pingBefore(url)` | Before the task runs. |
| `thenPing(url)` | After the task, **regardless of outcome** (a `finally`). |
| `pingOnSuccess(url)` | Only after the task completes without throwing. |
| `pingOnFailure(url)` | Only if the task throws. |

```ts
schedule
  .call(runNightlyImport)
  .dailyAt("2:00")
  .name("nightly-import")
  .pingBefore("https://hc-ping.com/abc/start")
  .pingOnSuccess("https://hc-ping.com/abc")
  .pingOnFailure("https://hc-ping.com/abc/fail");
```

**Ping failures never fail the task.** An unreachable monitoring webhook
must not break the thing it monitors, and neither does one that answers
500. They *are* logged at warning, though. A silently-dropped ping means
a dead-man's-switch monitor fires for a task that actually succeeded, and
you want to be able to tell those apart.

**Pings are bounded and concurrent.** Each gets a 5-second timeout
(`schedule.pingTimeoutMs`), and the URLs for one hook run together, so N
slow endpoints cost one timeout rather than N. Both matter because pings
sit *between* the scheduler and the task's work: a monitoring endpoint
that accepts the connection and then goes quiet would otherwise hang
`pingBefore()` indefinitely and stall every task behind it.

**Pings are fakeable.** They go through
[`@mahiframework/http-client`](../http-client/), not a bare `fetch()`, so a test
asserts on them without monkey-patching globals:

```ts
import { Http } from "@mahiframework/http-client";

Http.fake();
await task.run(app);
Http.assertSent("hc-ping.com/abc/start");
Http.restore();
```

### Metadata

| Method | Returns |
|---|---|
| `name(text)` | `this`. The task's identity. Throws on an empty name. |
| `withDescription(text)` | `this`. Alias for `name()`. |
| `withDefaultName(resolver)` | `this`. A fallback name, used only if `name()` wasn't called. |
| `getName()` | The name, or `undefined`. **No** cron fallback. |
| `getDescription()` | The name, or the cron expression if unset. |
| `getCronExpression()` | The five fields joined with spaces. |
| `getOverlapKey()` | The overlap lock key, or `undefined`. |
| `getOverlapExpiryMinutes()` | How long the lock is held before it lapses. |

### `withoutOverlapping(expiresAfterMinutes = 60)`

Skips a run if the previous invocation of **this** task is still going, by
holding a lock named after the task for the duration.

```ts
schedule.call(gc).daily().name("auth-gc").withoutOverlapping();
```

**The name is the lock key**, so a task using `withoutOverlapping()` must
have one. Without a name there is nothing to distinguish one task's lock
from another's, and `Schedule.validate()`, which runs at boot, rejects
it:

```
A scheduled task with the expression "0 0 * * *" uses withoutOverlapping()
but has no name. The name IS the lock key — without one, unrelated tasks
would share a lock and skip each other. Add .name("something-unique").
```

Two overlap-preventing tasks sharing a name are rejected the same way.
(Duplicate names are fine on tasks that don't prevent overlaps. There the
name is only a label.)

**Order in the chain doesn't matter.** The key is resolved when the task
runs, not when `withoutOverlapping()` is called, so these are identical:

```ts
schedule.call(gc).daily().name("auth-gc").withoutOverlapping();
schedule.call(gc).daily().withoutOverlapping().name("auth-gc");
```

`expiresAfterMinutes` bounds how long the lock survives if the process
dies without releasing it, otherwise one crash blocks the task forever.
It defaults to 60 minutes. **Size it above the task's worst-case
runtime**: a task still running when its lock lapses can be started again
concurrently, which is the one case overlap prevention doesn't cover.

```ts
schedule.call(rebuildIndex).hourly().name("rebuild-index").withoutOverlapping(180);
```

### `onOneServer(expiresAfterMinutes = 60)`

Run the task on **one** host when several run the scheduler:

```ts
schedule.call(chargeSubscriptions).dailyAt("02:00").name("billing").onOneServer();
```

Not the same problem as `withoutOverlapping()`, though they read alike:

| | Prevents |
|---|---|
| `withoutOverlapping()` | The task overlapping **itself over time**. A slow run colliding with the next. |
| `onOneServer()` | The task running **twice in one tick** across machines. |

A nightly billing job wants both, and they use separate lock keys so you
can have both.

**Needs a lock every host can see.** That means a shared cache store,
`CACHE_STORE=redis` plus `schedule.lockStore`. `runDueTasks()` refuses an
`ArrayCacheStore` (per-process, so no exclusion at all) and falls back to
lock files, which are only as global as the filesystem underneath them. On
a single host this is a no-op costing one round trip.

**The name is the lock key**, as with `withoutOverlapping()`, so a task
using it must have a unique one.

> **The claim is deliberately never released.** Releasing it at the end of
> the run would let a second host whose clock is a few seconds behind take
> it within the same minute and run the task again, exactly what the
> feature exists to prevent. It expires on its own instead, which is why
> the key includes the **minute**: every tick gets a fresh key, so a lock
> left sitting in the store cannot block tomorrow's run. Minute
> granularity is also what lets two hosts a few seconds apart agree on one
> key.

### `runInBackground()`

Due tasks otherwise run one after another, so a task taking 90 seconds
delays everything behind it. Marking one background starts it and moves
on:

```ts
schedule.call(slowSync).everyFiveMinutes().name("slow-sync").runInBackground();
```

The run still waits for every background task before finishing, so nothing
is orphaned and the process doesn't exit mid-task.

Unlike Laravel's version this is **not a child process**. It's the same
event loop. It buys concurrency for I/O-bound work (HTTP, queries) and
nothing at all for a CPU-bound loop, which still blocks everything.
Genuinely long or heavy work belongs on a [queue](../queues/).

### Evaluation and execution

| Method | Purpose |
|---|---|
| `isDueAt(date)` | Whether the cron matches that instant. |
| `nextRunAt(from = new Date())` | The next due time, or `undefined`. |
| `run(app)` | Run the callback, firing the pings around it. |

`nextRunAt()` scans forward from `from + 1 minute`, capped at ~1 year, and
returns `undefined` if nothing matches (`0 0 30 2 *`, February 30th,
never does). It evaluates in the task's own `timezone()`.

The scan skips whole days and hours that can't match, so a once-a-year
expression costs thousands of iterations rather than half a million. It
also steps by *timestamp*, not by local wall-clock minute: around a DST
fall-back the same local minute occurs twice, and incrementing local
minutes from the second occurrence walks backwards into the first, which
can loop.

`run(app)` does **not** check `isDueAt()` or `filtersPass()`. It runs the
callback unconditionally. Which is what `schedule:test` wants, and why
`runDueTasks()` does the checking itself.

`formatNextRun(date, timeZone?)` renders `YYYY-MM-DD HH:MM`, or
`"unknown"` for `undefined`. Pass the zone to render in it, without one
the output is server-local, which for a zoned task is a different wall
clock than the expression was written against. `schedule:list` always
passes it and appends the zone name.

## Cron matching

Five fields, in the standard order:

```
minute  hour  day-of-month  month  day-of-week
0-59    0-23  1-31          1-12   0-6 (0 = Sunday)
```

Day-of-week `7` is Sunday, the same as `0`, Vixie cron's convention.

Supported syntax, per comma-separated component:

| Form | Example | Meaning |
|---|---|---|
| `*` | `*` | Any value. |
| `?` | `?` | Any value. Day fields only (the Quartz spelling of `*`). |
| `*/n` | `*/5` | Every nth from the field's minimum. |
| `a-b` | `9-17` | Inclusive range. |
| `a-b/n` | `0-30/10` | Every nth within the range. |
| `a/n` | `5/15` | Every nth from `a` to the field's maximum. |
| `n` | `15` | Exactly that value. |
| names | `MON`, `JAN-MAR` | Case-insensitive three-letter day/month names. |
| lists | `1,15,30-45/5` | Any component may be mixed in a comma list. |

A field matches if **any** of its comma components match.

Note `*/n` counts from the field's *minimum*, not from zero, day-of-month
starts at 1, so `*/2` there is the 1st, 3rd, 5th, not the 2nd, 4th, 6th.

`L` in the day-of-month field means "the last calendar day of this month",
computed with `new Date(year, month, 0).getDate()` so leap years are
handled. It may appear as a comma component (`1,L` = the 1st and the
last).

### `@shorthand` expressions

| Shorthand | Equivalent |
|---|---|
| `@hourly` | `0 * * * *` |
| `@daily`, `@midnight` | `0 0 * * *` |
| `@weekly` | `0 0 * * 0` |
| `@monthly` | `0 0 1 * *` |
| `@yearly`, `@annually` | `0 0 1 1 *` |

`@reboot` is rejected with an explanation: it has no meaning for a
scheduler re-evaluated every minute.

### Validation

Everything above is checked when the expression is registered, by
`cron()`, or by `parseCronExpression()` directly, and never at match time.
An expression that got past registration cannot throw from `isDueAt()`.

`validateCronExpression(expression)` is the same check, exported for when
you want it without the compiled result.

### Day-of-month and day-of-week OR

Classic Vixie cron treats the two day fields as an **OR** when both are
restricted, and this matcher does the same:

```ts
if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) {
  return domMatches || dowMatches;
}
return domMatches && dowMatches;
```

So `0 0 1 * 1` is "the 1st of the month **or** any Monday", the same thing
a `crontab` line with that text does, and the same thing Laravel does.
When only one of the two is restricted, it simply applies. `?` counts as
unrestricted, so `0 0 ? * 1` is a plain "every Monday".

**Minute resolution.** Seconds are ignored entirely, matching standard
cron. There is no sub-minute scheduling; if you need it, you need a
worker loop, not a scheduler.

**Local server time by default.** A `timezone()` switches to `Intl`-based
extraction in that zone. Nothing is UTC unless the server is or you ask
for it.

## `runDueTasks`

Shared by `schedule:run` and `schedule:work`, so both behave identically.

Per task, in order:

1. **Filters first.** `filtersPass()` fails → return immediately. No lock
   is acquired, nothing is written. A filtered-out task never ran, so it
   must not leave a trace that would block the next tick. A filter that
   *throws* is logged and skips that task only.
2. **Overlap check.** If the task has an overlap key, `acquire()` it. It
   returns `false` when someone else holds it → log
   `Skipping overlapping task: {name}` at warning level and return.
3. **Run**, catching everything.
4. **Release** the lock in a `finally`.

**Nothing here rethrows.** A failing task, an unevaluatable expression, a
lock backend that errors, all logged, none fatal. One broken task must
never disable the rest of your schedule, nor kill the long-lived
`schedule:work` process. The consequence: `schedule:run` exits `0` even
when every task threw, so your monitoring has to come from the log or from
`pingOnFailure()`.

Failures are logged **with their stack**:

```ts
app.logger.error(`Scheduled task failed: ${task.getDescription()}`, {
  error: (error as Error).message,
  stack: (error as Error).stack,
});
```

Foreground tasks run **sequentially, in registration order**, a slow one
delays every task after it in the same tick, which is what
[`runInBackground()`](#runinbackground) exists for. Background tasks start
immediately and are all awaited before the run finishes.

## Overlap locking

`withoutOverlapping()` goes through a `ScheduleLocker`:

```ts
interface ScheduleLocker {
  acquire(key: string, expiresAfterMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}
```

Deliberately narrower than a general mutex. There is no "wait until
available", because a scheduled task already running should be *skipped*
this tick, not queued behind itself. `acquire()` returns a boolean rather
than throwing, so "someone else has it" (normal) is distinguishable from a
broken backend (which still throws).

### `ScheduleLock`: lock files, the default

The deployment model is why. `schedule:run` is fired by cron, which spawns
a **fresh Node process every minute**. There is no persistent worker to
hold "is the previous run still going" in memory. That state has to
outlive the process, and a file on disk is the simplest thing that does,
with zero infrastructure.

**Acquisition is atomic**: a single `open(path, "wx")`, which creates the
file only if it doesn't exist. Not a check followed by a write, two
`schedule:run` processes started in the same minute (which happens the
moment a run overruns its slot) would both pass the check and both run.

**Keys are hashed, not sanitised.** The filename is a SHA-256 prefix of
the key, so distinct keys cannot collide. Any description is safe;
punctuation no longer matters.

The file contains JSON, when it was taken, when it expires, the original
key, and the PID, so a leftover lock is traceable back to a task. A lock
past its expiry is treated as abandoned and can be taken over; that
takeover is itself serialised behind a second marker file, so two
processes reclaiming the same expired lock can't both win.

**This is a single-machine lock.** Two servers each running the crontab
have their own `storage/` and will both run every task. Run the scheduler
on exactly one machine, or use a cache-backed lock.

### `CacheScheduleLocker`: a lock that spans hosts

```ts
export function scheduleConfig(): ScheduleConfig {
  return {
    lockDirectory: "storage/schedule-locks",
    lockStore: "redis",
    pingTimeoutMs: 5_000,
  };
}
```

Setting `schedule.lockStore` moves overlap locks into a cache store. Over
Redis, whose `add()` is a `SET NX`, the lock becomes global, which is
what makes running the scheduler on more than one host safe (Laravel's
`onOneServer()`, by another name).

That guarantee is only as good as the store's. An in-memory store gives no
cross-process exclusion at all, so it is **refused** with a warning and
lock files are used instead, rather than silently pretending to lock.
A missing or unresolvable store falls back the same way, a misconfigured
lock backend should degrade overlap prevention, not stop the schedule.

Release is owner-checked: a task that overran its expiry, and whose lock
was therefore reclaimed by the next run, won't delete the new holder's
lock on its way out.

Don't reuse either of these as a general-purpose mutex; that's what
[`Cache.lock()`](../cache/#locks) is for.

## Commands

### `schedule:run`

```bash
./artisan schedule:run
```

Evaluates the schedule once against the current minute and runs whatever
is due. This is the command cron calls. It exits when the due tasks
finish.

### `schedule:list`

```bash
./artisan schedule:list
```

A table of `Cron / Description / Next Due` for every registered task.
`Next Due` comes from `nextRunAt()` via `formatNextRun()`, rendered in the
task's own timezone and labelled with it when it has one. Prints
`No scheduled tasks registered.` when empty.

The fastest way to check that a fluent chain produced the expression you
meant.

### `schedule:test`

```bash
./artisan schedule:test
```

Interactively pick one task and run it **immediately**, ignoring its cron
expression and its filters. It calls `task.run(app)` directly. Reports
`Task complete:` or `Task failed:` with the error message.

Tasks are keyed by index in the picker, so two tasks sharing a description
remain individually selectable.

It does **not** take the overlap lock. Running `schedule:test` on a task
that's currently running via `schedule:run` will overlap.

### `schedule:work`

```bash
./artisan schedule:work
./artisan schedule:work --once
```

A foreground loop that evaluates the schedule once per wall-clock minute,
a **local development convenience**, so you don't need a crontab while
developing. Runs until `SIGINT`/`SIGTERM`.

The loop polls every second and tracks which absolute minutes it has
already dispatched, so a run fires at most once per wall-clock minute even
though the tick is far more frequent. `--once` evaluates a single time and
exits, for tests and scripts.

**A tick that overruns doesn't swallow the next minute.** The loop
dispatches each minute's run and keeps polling rather than awaiting it, so
a 90-second tick no longer means minute N+1 is never evaluated. On
shutdown it waits for whatever is still in flight, so no task is left
half-run.

Unlike Laravel's `schedule:work`, there is **no per-tick child process**.
Node has no per-invocation state-isolation need, so tasks run directly
in-process through the same `runDueTasks()` path `schedule:run` uses.

That has a real consequence: under `schedule:work` the process is
long-lived, so module-level and container state persists between ticks. A
task that leaks memory or caches something stale will behave differently
than it does under cron. Test with `schedule:run` before trusting
production behaviour.

## Production

One crontab entry, on exactly one machine:

```cron
* * * * * cd /var/www/my-app && ./artisan schedule:run >> /dev/null 2>&1
```

Every minute, unconditionally. The scheduler decides what's actually due.
The absolute `cd` matters, `artisan` resolves paths (including
`storage/schedule-locks`) against `process.cwd()`.

Redirecting output to `/dev/null` is conventional but drops your task
logs; if you rely on `app.logger` writing to stdout, redirect to a file
instead:

```cron
* * * * * cd /var/www/my-app && ./artisan schedule:run >> storage/logs/schedule.log 2>&1
```

Container setups typically run `schedule:run` from a sidecar cron
container, or `schedule:work` as a long-lived process under the
orchestrator's restart policy. The latter is simpler in Kubernetes, at
the cost of the shared-process caveat above.

Long-running tasks should be `.job()`s, not `.call()`s. A `schedule:run`
that takes three minutes overlaps the next two cron ticks; the overlap
lock will skip those, but you've turned a "every minute" task into "every
four minutes" without noticing. Dispatch to a [queue](../queues/) and let
a worker own the runtime.

## Gotchas

**`withoutOverlapping()` requires a `name()`.** The app won't boot without
one. Order in the chain doesn't matter.

**Overlap-lock names must be unique.** Two overlap-preventing tasks
sharing a name is a boot error.

**`job()` defaults the name to the job class.** Object-literal factories
get no name, so set one.

**`job()` takes a factory.** An instance would go stale.

**Day 0 is Sunday, and so is day 7.**

**`monthlyOn(31)` skips short months.** Use `lastDayOfMonth()`.

**`cron()` replaces all five fields**, discarding earlier splices, and
validates them immediately.

**Day-of-month and day-of-week are OR-ed** when both are restricted, like
Vixie cron.

**`hourlyAt()` sets only the minute.** `daily().hourlyAt(30)` is 00:30
daily.

**Task failures are logged, not raised.** `schedule:run` exits `0`
regardless. Monitor via `pingOnFailure()` or the log.

**Foreground tasks run sequentially.** A slow one delays the rest of that
tick unless you mark it `runInBackground()`.

**`runInBackground()` is not a child process.** CPU-bound work still
blocks everything.

**Lock files are per-machine.** Run the scheduler on one host, or set
`schedule.lockStore` to a Redis store.

**An overlap lock expires after 60 minutes by default.** A task running
longer than its expiry can be started again concurrently.

**Everything is minute-resolution and local-time** unless you call
`timezone()`.

## Related

- [Queues](../queues/): `schedule.job()` dispatches into this
- [Providers](../providers/): the `schedule()` hook
- [Console](../console/): the `Command` base class scheduled callbacks often invoke
- [Configuration](../configuration/): `config/schedule.ts`
- [Deployment](../deployment/): running the scheduler in production
- [Cache](../cache/): `Cache.lock()`, for locking that isn't schedule overlap
