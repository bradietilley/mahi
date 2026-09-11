import type { Application } from "@mahi/core";
import { Http } from "@mahi/http-client";
import {
  isCompiledCronDue,
  nextCronRun,
  parseCronExpression,
  type CompiledCron,
} from "./cron-matcher.js";

export type TaskCallback = (app: Application) => void | Promise<void>;

/** A truthy-returning predicate used by `when()`/`skip()` filters. */
export type FilterCallback = (app: Application) => boolean | Promise<boolean>;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Field positions in a 5-field cron expression, for `spliceIntoPosition()`.
 *
 * A plain frozen object rather than a `const enum`: `const enum` is erased
 * by the compiler and therefore unusable under `isolatedModules` (which
 * this repo enables) and under any transpile-only toolchain — tsx, esbuild,
 * SWC — that compiles a file at a time.
 */
const CronField = {
  Minute: 0,
  Hour: 1,
  DayOfMonth: 2,
  Month: 3,
  DayOfWeek: 4,
} as const;

type CronFieldPosition = (typeof CronField)[keyof typeof CronField];

/** How long an overlap lock is held before it's considered abandoned, when the task doesn't say. */
export const DEFAULT_OVERLAP_EXPIRY_MINUTES = 60;

/**
 * Default whole-exchange timeout applied to every webhook ping, in
 * milliseconds. Override with `schedule.pingTimeoutMs`.
 */
export const DEFAULT_PING_TIMEOUT_MS = 5_000;

/**
 * A single recurring task: a callback plus a cron expression describing
 * when it's due, built fluently. Matches Laravel's scheduler API shape
 * closely since it's a well-known, well-tested vocabulary for this exact
 * problem — see `docs/scheduling/README.md`.
 */
export class ScheduledTask {
  // Held as individual fields so composable helpers like `daily().weekdays()`
  // can splice one position without disturbing the others — mirrors
  // Laravel's `spliceIntoPosition()`.
  private fields: [string, string, string, string, string] = ["*", "*", "*", "*", "*"];
  private description?: string;
  /**
   * Whether `withoutOverlapping()` was called. The lock KEY is not stored:
   * it is derived from the description at run time by `getOverlapKey()`,
   * so a `name()` called after `withoutOverlapping()` still takes effect.
   * Storing the resolved key here would make unrelated tasks share the
   * cron expression as a lock.
   */
  private overlapping = false;
  private overlapExpiresAfterMinutes = DEFAULT_OVERLAP_EXPIRY_MINUTES;
  /** Whether `onOneServer()` was called — see that method. */
  private oneServer = false;
  private oneServerExpiresAfterMinutes = DEFAULT_OVERLAP_EXPIRY_MINUTES;
  /** Whether this task runs concurrently with the rest of the tick — see `runInBackground()`. */
  private background = false;
  /** Supplies a default name when none was set explicitly — see `withDefaultName()`. */
  private defaultName?: () => string | undefined;
  /** Memoised `defaultName()` result, so the resolver runs at most once. */
  private resolvedDefaultName?: { value: string | undefined };
  private timeZone?: string;
  private filters: FilterCallback[] = [];
  private rejects: FilterCallback[] = [];
  private pingBeforeUrls: string[] = [];
  private pingAfterUrls: string[] = [];
  private pingSuccessUrls: string[] = [];
  private pingFailureUrls: string[] = [];
  /** Memoised compilation of `fields`, invalidated whenever a field changes. */
  private compiled?: CompiledCron;

  constructor(private callback: TaskCallback) {}

  /** Replaces a single cron field, leaving the others intact. */
  private spliceIntoPosition(position: CronFieldPosition, value: string): this {
    this.fields[position] = value;
    this.compiled = undefined;

    return this;
  }

  everyMinute(): this {
    return this.spliceIntoPosition(CronField.Minute, "*");
  }

  everyTwoMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/2");
  }

  everyThreeMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/3");
  }

  everyFourMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/4");
  }

  everyFiveMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/5");
  }

  everyTenMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/10");
  }

  everyFifteenMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/15");
  }

  everyThirtyMinutes(): this {
    return this.spliceIntoPosition(CronField.Minute, "*/30");
  }

  hourly(): this {
    return this.spliceIntoPosition(CronField.Minute, "0");
  }

  /** Run hourly at a given minute offset, e.g. `hourlyAt(15)` → ":15 past every hour". */
  hourlyAt(offset: number): this {
    if (!Number.isInteger(offset) || offset < 0 || offset > 59) {
      throw new Error(`Invalid minute offset "${offset}" passed to hourlyAt() — expected 0-59.`);
    }

    return this.spliceIntoPosition(CronField.Minute, String(offset));
  }

  everyTwoHours(): this {
    return this.spliceIntoPosition(CronField.Minute, "0").spliceIntoPosition(CronField.Hour, "*/2");
  }

  everyThreeHours(): this {
    return this.spliceIntoPosition(CronField.Minute, "0").spliceIntoPosition(CronField.Hour, "*/3");
  }

  everyFourHours(): this {
    return this.spliceIntoPosition(CronField.Minute, "0").spliceIntoPosition(CronField.Hour, "*/4");
  }

  everySixHours(): this {
    return this.spliceIntoPosition(CronField.Minute, "0").spliceIntoPosition(CronField.Hour, "*/6");
  }

  daily(): this {
    return this.spliceIntoPosition(CronField.Minute, "0").spliceIntoPosition(CronField.Hour, "0");
  }

  /** `time` in "HH:MM" 24-hour format, e.g. `dailyAt("13:30")`. */
  dailyAt(time: string): this {
    const { hour, minute } = parseTime(time);

    return this.spliceIntoPosition(CronField.Minute, String(minute)).spliceIntoPosition(
      CronField.Hour,
      String(hour),
    );
  }

  /** Alias for `dailyAt()`, matching Laravel's `at()`. */
  at(time: string): this {
    return this.dailyAt(time);
  }

  weekly(): this {
    return this.daily().spliceIntoPosition(CronField.DayOfWeek, "0");
  }

  /**
   * Run weekly on a given day (0 = Sunday … 6 = Saturday) at an optional
   * "HH:MM" time (defaults to midnight). Matches Laravel's `weeklyOn()`.
   */
  weeklyOn(dayOfWeek: number, time = "0:0"): this {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new Error(
        `Invalid dayOfWeek "${dayOfWeek}" passed to weeklyOn() — expected 0 (Sun) - 6 (Sat).`,
      );
    }

    return this.dailyAt(time).spliceIntoPosition(CronField.DayOfWeek, String(dayOfWeek));
  }

  /** Constrain to Monday–Friday. Compose with a time, e.g. `dailyAt("9:00").weekdays()`. */
  weekdays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "1,2,3,4,5");
  }

  /** Constrain to Saturday & Sunday. */
  weekends(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "0,6");
  }

  sundays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "0");
  }

  mondays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "1");
  }

  tuesdays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "2");
  }

  wednesdays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "3");
  }

  thursdays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "4");
  }

  fridays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "5");
  }

  saturdays(): this {
    return this.spliceIntoPosition(CronField.DayOfWeek, "6");
  }

  monthly(): this {
    return this.daily().spliceIntoPosition(CronField.DayOfMonth, "1");
  }

  /**
   * Run monthly on a given day-of-month at an optional "HH:MM" time
   * (defaults to midnight). Matches Laravel's `monthlyOn()`.
   */
  monthlyOn(dayOfMonth: number, time = "0:0"): this {
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error(`Invalid dayOfMonth "${dayOfMonth}" passed to monthlyOn() — expected 1-31.`);
    }

    return this.dailyAt(time).spliceIntoPosition(CronField.DayOfMonth, String(dayOfMonth));
  }

  /** Run on the last calendar day of the month (uses the cron `L` token). */
  lastDayOfMonth(time = "0:0"): this {
    return this.dailyAt(time).spliceIntoPosition(CronField.DayOfMonth, "L");
  }

  /**
   * Set all five fields at once from a raw expression (or an `@daily`-style
   * shorthand, which is expanded here).
   *
   * The expression is fully parsed **now**, so an out-of-range value, an
   * unknown name, or an inverted range throws at registration — naming the
   * field and the offending text — rather than from inside `schedule:run`
   * where it once took every other due task down with it.
   */
  cron(expression: string): this {
    const compiled = parseCronExpression(expression);
    this.fields = [...compiled.fields] as [string, string, string, string, string];
    this.compiled = compiled;

    return this;
  }

  /**
   * Evaluate this task's cron fields against the given IANA timezone
   * (e.g. `"America/New_York"`) rather than local server time.
   */
  timezone(zone: string): this {
    this.timeZone = zone;

    return this;
  }

  getTimezone(): string | undefined {
    return this.timeZone;
  }

  /** Only run when `callback` returns truthy. Multiple filters are AND-ed. */
  when(callback: FilterCallback): this {
    this.filters.push(callback);

    return this;
  }

  /** Skip the run when `callback` returns truthy. Multiple skips are OR-ed. */
  skip(callback: FilterCallback): this {
    this.rejects.push(callback);

    return this;
  }

  /**
   * Evaluate every `when()`/`skip()` filter against the app. Returns true
   * only if all `when()` pass and no `skip()` triggers. Called by
   * `schedule:run` right before a due task runs.
   */
  async filtersPass(app: Application): Promise<boolean> {
    for (const filter of this.filters) {
      if (!(await filter(app))) {
        return false;
      }
    }

    for (const reject of this.rejects) {
      if (await reject(app)) {
        return false;
      }
    }

    return true;
  }

  /** Ping (HTTP GET) `url` before the task runs. */
  pingBefore(url: string): this {
    this.pingBeforeUrls.push(url);

    return this;
  }

  /** Ping (HTTP GET) `url` after the task runs (regardless of outcome). */
  thenPing(url: string): this {
    this.pingAfterUrls.push(url);

    return this;
  }

  /** Ping (HTTP GET) `url` only after the task completes successfully. */
  pingOnSuccess(url: string): this {
    this.pingSuccessUrls.push(url);

    return this;
  }

  /** Ping (HTTP GET) `url` only if the task throws. */
  pingOnFailure(url: string): this {
    this.pingFailureUrls.push(url);

    return this;
  }

  /**
   * Name the task. The name identifies it in `schedule:list`, in log
   * lines, and — crucially — as the `withoutOverlapping()` lock key, so it
   * must be unique across the schedule.
   */
  name(text: string): this {
    if (text.trim() === "") {
      throw new Error(
        `A scheduled task's name cannot be empty — it identifies the task and keys its overlap lock.`,
      );
    }

    this.description = text;

    return this;
  }

  /** Alias for `name()`, kept because it reads better in some chains. */
  withDescription(text: string): this {
    return this.name(text);
  }

  /**
   * Register a fallback name, used only when `name()` was never called.
   *
   * `Schedule.job()` uses this to name a task after its job class. The
   * resolver is deferred and memoised rather than run eagerly for two
   * reasons: it constructs a job purely to read a class name, which is
   * wasted work when the caller names the task anyway, and doing it at
   * registration would run application code during boot — where a factory
   * that touches the container or the database would turn "we couldn't
   * pick a nice default name" into "the app won't start".
   */
  withDefaultName(resolver: () => string | undefined): this {
    this.defaultName = resolver;

    return this;
  }

  /**
   * Skip this run if the previous invocation of **this** task is still
   * running, by holding a lock named after the task for the duration.
   *
   * The lock key is the task's `name()`, resolved when the task actually
   * runs rather than when this method is called — so ordering in the chain
   * doesn't matter and `withoutOverlapping().name("x")` behaves the same as
   * `name("x").withoutOverlapping()`. A task with no name has no key that
   * could distinguish it from any other, so `Schedule` rejects it at
   * registration instead of silently sharing one lock between unrelated
   * tasks (which is exactly what keying off the cron expression would
   * do).
   *
   * `expiresAfterMinutes` bounds how long the lock is held if the process
   * dies without releasing it; a task that legitimately runs longer than
   * this can be started again concurrently, so size it above the task's
   * worst-case runtime. Defaults to 60 minutes, matching Laravel's
   * `withoutOverlapping($expiresAt = 1440)` in spirit if not in value.
   */
  withoutOverlapping(expiresAfterMinutes: number = DEFAULT_OVERLAP_EXPIRY_MINUTES): this {
    if (!Number.isFinite(expiresAfterMinutes) || expiresAfterMinutes <= 0) {
      throw new Error(
        `Invalid expiry "${expiresAfterMinutes}" passed to withoutOverlapping() — expected a positive number of minutes.`,
      );
    }

    this.overlapping = true;
    this.overlapExpiresAfterMinutes = expiresAfterMinutes;

    return this;
  }

  /**
   * Run this task on only **one** host when several run the scheduler.
   *
   * Laravel's `onOneServer()`. Distinct from `withoutOverlapping()`,
   * which stops a task overlapping *itself* across time; this stops it
   * running *twice in the same tick* across machines. A nightly billing
   * job wants both: not two at once on one host, and not one per host.
   *
   * Needs a lock every host can see, which means a cache store shared
   * between them — `CACHE_STORE=redis`. `runDueTasks()` refuses an
   * `ArrayCacheStore` (per-process, so no exclusion at all) and falls
   * back to lock files, which are only as global as the filesystem. On a
   * single host this is a no-op that costs one cache round trip.
   *
   * The lock is **deliberately not released** when the task finishes.
   * Releasing it would let a second host whose clock is a few seconds
   * behind acquire it within the same minute and run the task again,
   * which is the exact thing being prevented. It instead expires on its
   * own after `expiresAfterMinutes` (default 1 hour), so the key must
   * also identify the *tick*, not just the task — see
   * `getOneServerKey()`.
   *
   * Like `withoutOverlapping()`, the name is the lock key, so a task
   * using this must have one.
   */
  onOneServer(expiresAfterMinutes: number = DEFAULT_OVERLAP_EXPIRY_MINUTES): this {
    if (!Number.isFinite(expiresAfterMinutes) || expiresAfterMinutes <= 0) {
      throw new Error(
        `Invalid expiry "${expiresAfterMinutes}" passed to onOneServer() — expected a positive number of minutes.`,
      );
    }

    this.oneServer = true;
    this.oneServerExpiresAfterMinutes = expiresAfterMinutes;

    return this;
  }

  /** Whether `onOneServer()` was called on this task. */
  runsOnOneServer(): boolean {
    return this.oneServer;
  }

  /**
   * The lock key for `onOneServer()` at the given tick, or `undefined`
   * when it isn't enabled.
   *
   * The minute is part of the key, which is what makes a never-released
   * lock correct rather than a permanent block: each due minute is a
   * fresh key, so tomorrow's run is unaffected by today's lock still
   * sitting in the store. Seconds are excluded so two hosts a few
   * seconds apart compute the same key for the same tick — the whole
   * point.
   */
  getOneServerKey(at: Date): string | undefined {
    if (!this.oneServer) {
      return undefined;
    }

    const minute = [
      at.getUTCFullYear(),
      String(at.getUTCMonth() + 1).padStart(2, "0"),
      String(at.getUTCDate()).padStart(2, "0"),
      String(at.getUTCHours()).padStart(2, "0"),
      String(at.getUTCMinutes()).padStart(2, "0"),
    ].join("");

    return `schedule-one-server:${this.getName() ?? this.getCronExpression()}:${minute}`;
  }

  /** How long an `onOneServer()` claim survives before expiring. */
  getOneServerExpiryMinutes(): number {
    return this.oneServerExpiresAfterMinutes;
  }

  /** Whether `withoutOverlapping()` was called on this task. */
  preventsOverlaps(): boolean {
    return this.overlapping;
  }

  /**
   * Let this task run alongside the rest of the tick instead of holding
   * the queue up.
   *
   * Due tasks otherwise run one after another in registration order, so a
   * task that takes 90 seconds delays every task behind it by 90 seconds —
   * and under `schedule:run` pushes the whole tick past the next cron
   * firing. Marking a task background starts it and moves on; the run
   * still waits for all of them before finishing, so nothing is orphaned
   * and the process doesn't exit mid-task.
   *
   * Unlike Laravel's version this is not a child process — it's the same
   * event loop — so it buys concurrency for I/O-bound work (HTTP calls,
   * queries) and nothing at all for a CPU-bound loop, which will still
   * block everything. Genuinely long or heavy work belongs on a queue.
   */
  runInBackground(): this {
    this.background = true;

    return this;
  }

  /** Whether `runInBackground()` was called on this task. */
  runsInBackground(): boolean {
    return this.background;
  }

  /** The task's name, or its cron expression when it has none. */
  getDescription(): string {
    return this.getName() ?? this.getCronExpression();
  }

  /**
   * The task's name: the one set with `name()`, else whatever
   * `withDefaultName()`'s resolver produces, else `undefined`. Unlike
   * `getDescription()` there is no cron-expression fallback, because the
   * callers that matter — overlap locking and `Schedule.validate()` — need
   * to know when a task genuinely has no identity of its own.
   */
  getName(): string | undefined {
    if (this.description !== undefined) {
      return this.description;
    }

    if (this.defaultName === undefined) {
      return undefined;
    }

    this.resolvedDefaultName ??= { value: this.defaultName() };

    return this.resolvedDefaultName.value;
  }

  getCronExpression(): string {
    return this.fields.join(" ");
  }

  /**
   * The lock key `withoutOverlapping()` uses, or `undefined` if overlap
   * prevention isn't enabled. Derived from the name at call time, which is
   * why `Schedule` insists a task using it has one.
   */
  getOverlapKey(): string | undefined {
    if (!this.overlapping) {
      return undefined;
    }

    return `schedule-overlap:${this.getName() ?? this.getCronExpression()}`;
  }

  /** How long the overlap lock is held before it's treated as abandoned. */
  getOverlapExpiryMinutes(): number {
    return this.overlapExpiresAfterMinutes;
  }

  /** The compiled form of this task's expression, parsed on first use and memoised. */
  private compiledCron(): CompiledCron {
    this.compiled ??= parseCronExpression(this.getCronExpression());

    return this.compiled;
  }

  isDueAt(date: Date): boolean {
    return isCompiledCronDue(this.compiledCron(), date, this.timeZone);
  }

  /**
   * The next instant this task is due after `from`, or `undefined` if
   * there is none within a year (`monthlyOn(30)` in a February-only
   * expression, say). Evaluated in the task's `timezone()` if it has one.
   */
  nextRunAt(from: Date = new Date()): Date | undefined {
    return nextCronRun(this.compiledCron(), from, this.timeZone);
  }

  async run(app: Application): Promise<void> {
    await this.pingAll(app, this.pingBeforeUrls);
    try {
      await this.callback(app);
      await this.pingAll(app, this.pingSuccessUrls);
    } catch (error) {
      await this.pingAll(app, this.pingFailureUrls);
      throw error;
    } finally {
      await this.pingAll(app, this.pingAfterUrls);
    }
  }

  /**
   * Fire each configured webhook ping as a GET, concurrently, with a 5s
   * timeout each.
   *
   * Both of those matter: pings sit *between* the scheduler and the task's
   * work, so a monitoring endpoint that accepts a connection and then
   * never answers would otherwise hang `pingBefore()` indefinitely and —
   * since tasks in a tick share a process — stall every task behind it.
   * `AbortSignal.timeout()` inside the client bounds the wait; running the
   * URLs together bounds the total at one timeout rather than one per URL.
   *
   * A failure never fails the task — an unreachable monitoring webhook
   * must not break the thing it monitors — but it IS logged at warning,
   * because a silently-dropped ping means a dead-man's-switch monitor
   * fires for a task that actually succeeded, and you want to be able to
   * tell those apart.
   *
   * Goes through `@mahi/http-client` rather than a bare `fetch()` so pings
   * are fakeable: a test asserts on them with `Http.fake()` /
   * `Http.assertSent()` instead of monkey-patching `globalThis.fetch`.
   * Note that a non-2xx response resolves rather than throwing, so an
   * unreachable *endpoint* and an erroring one are both non-fatal here.
   */
  private async pingAll(app: Application, urls: string[]): Promise<void> {
    if (urls.length === 0) {
      return;
    }

    const timeoutMs = app.config.get<number>("schedule.pingTimeoutMs", DEFAULT_PING_TIMEOUT_MS);

    await Promise.all(
      urls.map(async (url) => {
        try {
          await Http.timeout(timeoutMs).get(url);
        } catch (error) {
          app.logger.warning(`Scheduled task ping failed: ${this.getDescription()}`, {
            url,
            error: (error as Error).message,
          });
        }
      }),
    );
  }
}

/** Parses an "HH:MM" (or "H:M") 24-hour time into numeric hour/minute. */
function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time);

  if (!match) {
    throw new Error(`Invalid time "${time}" — expected "HH:MM".`);
  }

  const [, hourStr, minuteStr] = match as unknown as [string, string, string];
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid time "${time}" — hour must be 0-23 and minute 0-59.`);
  }

  return { hour, minute };
}

/**
 * Renders a next-due instant as `YYYY-MM-DD HH:MM`, or `"unknown"` for
 * `undefined`.
 *
 * Pass the task's `timeZone` to render in that zone. Without it the
 * output is server-local, which for a task scheduled with `timezone()` is
 * a different wall clock than the one its expression was written
 * against — `schedule:list` therefore always passes it, and appends the
 * zone name so the column is unambiguous.
 */
export function formatNextRun(date: Date | undefined, timeZone?: string): string {
  if (!date) {
    return "unknown";
  }

  if (!timeZone) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const lookup: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }

  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}`;
}
