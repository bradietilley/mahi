import { QUEUE_TOKEN, type Application } from "@mahi/core";
import { ScheduledTask, type TaskCallback } from "./scheduled-task.js";

/**
 * Structural stand-in for a `@mahi/queue` `Job` instance — kept
 * minimal (a nominal marker via `handle`) so `@mahi/schedule` never
 * needs a compile-time import of the queue package.
 */
interface JobLike {
  handle(): void | Promise<void>;
}

interface QueueManagerLike {
  dispatch(job: JobLike, options?: { delaySeconds?: number; connection?: string }): Promise<void>;
}

/** What `dueTasks()` reports when a task's cron expression can't be evaluated. */
export interface ScheduleEvaluationError {
  task: ScheduledTask;
  error: Error;
}

/**
 * Registry of every recurring task defined across the app. `.job()`
 * softly depends on `@mahi/queue` — resolved via `app.make(QUEUE_TOKEN)`
 * using the string token only (no compile-time import), so
 * `@mahi/schedule` never hard-depends on the queue package. Calling
 * `.job()` without a queue provider registered throws a clear error.
 */
export class Schedule {
  private tasks: ScheduledTask[] = [];

  constructor(private app: Application) {}

  call(callback: TaskCallback): ScheduledTask {
    const task = new ScheduledTask(callback);
    this.tasks.push(task);

    return task;
  }

  /**
   * Convenience for dispatching a queued job on a schedule. Takes a
   * FACTORY (`() => new SomeJob(...)`) rather than a single instance, so
   * each run enqueues a fresh job built from current state (a job captured
   * once would carry stale fields — e.g. a model loaded at schedule-define
   * time — on every subsequent tick).
   *
   *   schedule.job(() => new PruneStaleRecordsJob()).daily();
   *
   * The task defaults to being named after the job class the factory
   * produces. That default is what makes `schedule:list` readable and,
   * more importantly, gives each job task a distinct
   * `withoutOverlapping()` lock — a generic `"job"` name would share a
   * single lock with every other scheduled job in the app. `name()`
   * overrides it, and skips deriving it at all.
   */
  job(factory: () => JobLike): ScheduledTask {
    return this.call(async (app) => {
      if (!app.has(QUEUE_TOKEN)) {
        throw new Error(
          `schedule.job() requires @mahi/queue's QueueServiceProvider to be registered.`,
        );
      }

      const queue = app.make<QueueManagerLike>(QUEUE_TOKEN);
      await queue.dispatch(factory());
    }).withDefaultName(() => probeJobName(factory));
  }

  /**
   * Tasks due at `at`, in registration order.
   *
   * A task whose expression throws while being evaluated is **excluded and
   * reported**, not propagated: `runDueTasks()` calls this once for the
   * whole schedule, so letting one expression's error escape would abort
   * the entire tick — every other due task silently skipped, and
   * `schedule:work` dead. Expressions are validated at registration now,
   * so reaching this is a bug rather than a typo; it still must not be
   * able to take the scheduler down.
   *
   * Pass `errors` to collect what was excluded (`runDueTasks()` logs them).
   */
  dueTasks(at: Date = new Date(), errors?: ScheduleEvaluationError[]): ScheduledTask[] {
    const due: ScheduledTask[] = [];

    for (const task of this.tasks) {
      try {
        if (task.isDueAt(at)) {
          due.push(task);
        }
      } catch (error) {
        errors?.push({ task, error: error as Error });
      }
    }

    return due;
  }

  all(): readonly ScheduledTask[] {
    return this.tasks;
  }

  /**
   * Validates the schedule as a whole, throwing on the first problem.
   * Called by `ScheduleServiceProvider.boot()` once every provider has
   * contributed, so these are startup errors rather than 3am surprises:
   *
   * - a task using `withoutOverlapping()` without a `name()`, which would
   *   otherwise fall back to the cron expression and silently serialise
   *   against every unrelated task sharing that schedule;
   * - two overlap-preventing tasks with the same name, which collide the
   *   same way even though both were named.
   *
   * Duplicate names on tasks that DON'T prevent overlaps are left alone:
   * there the name is only a label, and two `schedule.job(() => new
   * SyncJob())` registrations at different frequencies are a legitimate
   * thing to write.
   */
  validate(): void {
    const seen = new Set<string>();

    for (const task of this.tasks) {
      // Both features key their lock off the name, so both need one and
      // both need it to be unique.
      const usesLock = task.preventsOverlaps() || task.runsOnOneServer();

      if (!usesLock) {
        continue;
      }

      const method = task.preventsOverlaps() ? "withoutOverlapping()" : "onOneServer()";
      const name = task.getName();

      if (name === undefined) {
        throw new Error(
          `A scheduled task with the expression "${task.getCronExpression()}" uses ${method} but has no name. ` +
            `The name IS the lock key — without one, unrelated tasks would share a lock and skip each other. ` +
            `Add .name("something-unique").`,
        );
      }

      if (seen.has(name)) {
        throw new Error(
          `Two scheduled tasks named "${name}" both use ${method} or withoutOverlapping(), so they would share ` +
            `one lock and skip each other. Give them distinct names.`,
        );
      }

      seen.add(name);
    }
  }
}

/**
 * Builds one job from `factory` solely to read its class name for the
 * task's default name.
 *
 * A factory is normally cheap (`() => new SomeJob()`), but it is
 * application code running at registration time, and a factory that reads
 * a request-scoped binding or hits a database would throw here — where
 * "we couldn't derive a nice default name" must not become "your app
 * won't boot". So: failures fall back to no name, and the task keeps its
 * cron expression as its description. Anonymous classes and plain object
 * literals (whose constructor is `Object`) also yield nothing useful and
 * are skipped.
 */
function probeJobName(factory: () => JobLike): string | undefined {
  let job: JobLike;
  try {
    job = factory();
  } catch {
    return undefined;
  }

  const name = (job as object)?.constructor?.name;

  if (!name || name === "Object" || name === "Function") {
    return undefined;
  }

  return name;
}
