import type { CacheStore } from "@mahiframework/cache";
import type { JobMiddleware } from "./middleware/job-middleware.js";

/**
 * The unit of deferred work, analogous to `Event`/`Listener` in shape,
 * but for execution later (possibly in a different process) instead of
 * synchronous pub/sub within the current request/command lifecycle.
 *
 * A job carries its own payload as constructor-assigned fields and is
 * dispatched by instance:
 *
 *   class WelcomePostAuthorJob extends Job {
 *     constructor(public readonly author: User, public readonly post: Post) {
 *       super();
 *     }
 *     handle(): void {
 *       app().logger.info("welcoming", { userId: this.author.id });
 *     }
 *   }
 *
 *   await Bus.dispatch(new WelcomePostAuthorJob(author, post));
 *
 * `handle()` reads everything it needs off `this` (and the global `app()`
 * helper for container access). There is no separate `payload` argument.
 * A durable driver persists the job's own enumerable fields (with any
 * `Model` fields encoded to `{ __model, __id }` references) and, in
 * whatever process later works the job, rebuilds a fresh instance via
 * `Object.create(JobClass.prototype)` before reassigning the (rehydrated)
 * fields, so the constructor is NOT re-run on the worker. See
 * `job-serialization.ts` and `JobRegistry` for the name<->class mapping.
 */
export abstract class Job {
  /**
   * How many times this job may be attempted before moving to failed_jobs.
   * Defined on the PROTOTYPE (see the assignment below), not as an instance
   * field, so it isn't captured as an own field by `encodeJob`'s `{...job}`
   * spread for the common (unchanged) case, a job rebuilt via
   * `Object.create(JobClass.prototype)` inherits the default. A subclass
   * that customizes it with a field initializer (`maxAttempts = 5`) DOES
   * make it an own field, so that value is serialized and restored.
   */
  declare maxAttempts: number;

  /**
   * Optional per-class default for "hold this dispatch until the
   * enclosing database transaction commits", Laravel's `$afterCommit`.
   * Overridden by an explicit `Bus.dispatch(job, { afterCommit })`, and
   * overriding the connection's own `afterCommit` config.
   *
   * Set it on a job that reads rows written by the transaction it is
   * dispatched from (which is most of them):
   *
   *   class ChargeOrderJob extends Job {
   *     afterCommit = true;
   *     constructor(public readonly order: Order) { super(); }
   *   }
   *
   * Like `maxAttempts`, declaring it with a field initializer makes it an
   * own enumerable field, so it is captured into the job's persisted
   * state, harmless (it is only read at dispatch) but worth knowing.
   */
  declare afterCommit?: boolean;

  abstract handle(): void | Promise<void>;

  /**
   * Optional, the number of SECONDS to wait before the next attempt after
   * this job throws, given the attempt count that just failed (1-based).
   * Overrides the worker's default linear `attempts * 5` backoff when
   * present. Reads state off `this`; ≈ Laravel's `backoff()` / `$backoff`.
   *
   *   backoff(attempts: number): number {
   *     return [5, 30, 120][attempts - 1] ?? 300; // exponential-ish
   *   }
   */
  backoff?(attempts: number): number;

  /**
   * Optional, a wall-clock deadline past which the job stops being
   * retried (moving straight to failed_jobs) regardless of how many
   * attempts remain, ≈ Laravel's `retryUntil()`/`$retryUntil`. Return a
   * `Date` or an epoch-milliseconds number. Reads state off `this`.
   *
   * NOTE: like Laravel, a `retryUntil()` that captures "now + N" must be
   * stable across attempts. Because a job is rebuilt from its persisted
   * fields on each attempt, compute the deadline from a field set at
   * construction time (e.g. `this.deadline`), not from `Date.now()` inside
   * the method, otherwise it slides forward every attempt.
   */
  retryUntil?(): Date | number;

  /**
   * Optional, a soft per-job timeout in SECONDS. When set, `handle()` is
   * raced against a timer; if the timer wins, the attempt is treated as a
   * failure (`JobTimeoutError`). Unlike PHP's `pcntl`-based hard kill, this
   * is cooperative: the underlying `handle()` promise may still be running
   * in the background after the race rejects (JS cannot forcibly abort an
   * in-flight `await`). Reads state off `this`; ≈ Laravel's `$timeout`.
   */
  timeout?(): number;

  /**
   * Optional, job middleware wrapping the call to `handle()`, run as a
   * `@mahiframework/pipeline` pipeline (exactly like Laravel's `middleware()`
   * on a queued job). Built-ins: `RateLimited`, `WithoutOverlapping`,
   * `ThrottlesExceptions`. A middleware may throw `ReleaseJobError` to
   * reschedule the job instead of failing it. Runs identically under the
   * `sync` and `database` drivers. Reads state off `this`.
   */
  middleware?(): JobMiddleware[];

  /** Optional, called if the job exhausts maxAttempts. Reads state off `this`. */
  failed?(error: Error): void | Promise<void>;

  /**
   * Optional, a stable identifier distinguishing *which* unique job this
   * is, appended to the lock key (`mahi:unique:<JobName>:<uniqueId>`).
   * Only consulted when the class opts into uniqueness via the static
   * `unique` marker (see {@link UniqueMode}). Read state off `this`:
   *
   *   class SyncInventory extends Job {
   *     static unique = "untilFinished" as const;
   *     constructor(public readonly sku: string) { super(); }
   *     uniqueId(): string { return this.sku; }
   *     handle(): void {}
   *   }
   *
   * Defaults to `""` (class-wide uniqueness, only one instance of the
   * job may be queued at a time) when omitted.
   */
  uniqueId?(): string;

  /**
   * Optional, how long (in **seconds**) the uniqueness lock is held
   * before it auto-expires, the crash safety net: a worker that dies
   * mid-job would otherwise hold the lock until this elapses rather than
   * blocking new dispatches forever. Defaults to the connection's
   * `uniqueFor` config, then `3600`. Read state off `this`.
   */
  uniqueFor?(): number;

  /**
   * Optional, the cache store (name, or a live `CacheStore`) backing the
   * uniqueness lock. Defaults to the cache manager's default store. Note
   * an `array` store makes uniqueness per-process only (fine for tests,
   * wrong for multiple workers). Read state off `this`.
   */
  uniqueVia?(): string | CacheStore;
}

/**
 * How long a {@link ShouldBeUnique} job's uniqueness lock is held:
 *
 *   - `"untilFinished"`, from dispatch until the job **finishes**
 *     (deleted after success, or failed after exhausting attempts). A
 *     duplicate dispatch is a silent no-op while one is queued OR running.
 *   - `"untilProcessing"`, from dispatch until the worker **starts**
 *     processing it (released before `handle()` runs), so a new instance
 *     can be queued while one runs.
 */
export type UniqueMode = "untilFinished" | "untilProcessing";

/**
 * A `Job` subclass that opts into dispatch-time uniqueness. Rather than an
 * `instanceof`-checked marker interface (which can't survive
 * serialisation), the opt-in is a **static** `unique` field on the class,
 * so it is intrinsic to the class the worker resolves by registry name and
 * needs no payload flag:
 *
 *   class GenerateReport extends Job {
 *     static unique = "untilFinished" as const;
 *     handle(): void {}
 *   }
 *
 * Read the mode off a class with {@link uniqueModeOf}.
 */
export interface UniqueJobClass {
  unique?: UniqueMode;
}

/**
 * The uniqueness mode a job class opted into, or `undefined` for a job
 * with no `static unique` marker. Reads the static off the class the
 * instance was built from, works for both a live instance and a class
 * rebuilt via `Object.create(JobClass.prototype)`, since statics live on
 * the constructor either way.
 */
export function uniqueModeOf(job: Job): UniqueMode | undefined {
  const ctor = (job as { constructor?: UniqueJobClass }).constructor;

  return ctor?.unique;
}

// Default `maxAttempts` lives on the prototype (see the field docstring):
// inherited by `Object.create(JobClass.prototype)` rebuilds, and NOT an own
// enumerable field, so `encodeJob`'s `{...job}` spread ignores it unless a
// subclass explicitly overrides it with its own field initializer.
Job.prototype.maxAttempts = 3;

/**
 * A job constructor reference. Job constructors take their payload as
 * arguments (`new WelcomePostAuthorJob(author, post)`), so this is an
 * arbitrary-arity constructor type. The worker never calls it directly
 * (it rebuilds via `Object.create`); it's only used as a registry key and
 * for `Object.create(JobClass.prototype)`.
 */
export type JobClass = abstract new (...args: any[]) => Job;
