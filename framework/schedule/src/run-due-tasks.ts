import { CACHE_TOKEN, type Application } from "@mahiframework/core";
import type { Schedule, ScheduleEvaluationError } from "./schedule.js";
import type { ScheduledTask } from "./scheduled-task.js";
import { ScheduleLock } from "./locking/schedule-lock.js";
import { CacheScheduleLocker, type LockingCacheStore } from "./locking/cache-schedule-locker.js";
import type { ScheduleLocker } from "./locking/schedule-locker.js";

/** The `schedule` config block. All keys optional; defaults documented per field. */
export interface ScheduleRunConfig {
  /** Where `ScheduleLock` writes lock files. Default `"storage/schedule-locks"`. */
  lockDirectory?: string;
  /**
   * Name of a cache store to back `withoutOverlapping()` with instead of
   * lock files. Only worth setting for a store shared between hosts
   * (Redis) — see `CacheScheduleLocker`.
   */
  lockStore?: string;
}

/**
 * Evaluates and runs every task due at `at`, honouring `when()`/`skip()`
 * filters and `withoutOverlapping()` locks. Shared by `schedule:run` (one
 * shot) and `schedule:work` (once per minute) so both behave identically.
 *
 * Foreground tasks run **sequentially, in registration order** — the same
 * ordering guarantee the scheduler has always had, which tasks written
 * against it may rely on. Tasks marked `runInBackground()` are started
 * immediately and run alongside the rest, so one slow task no longer
 * delays everything after it; see `ScheduledTask.runInBackground()`.
 *
 * Nothing here rethrows: a failing task, an unevaluatable expression, and
 * a lock backend that errors are all logged. One broken task must never
 * prevent the remaining due tasks from running, nor kill the long-lived
 * `schedule:work` process.
 */
export async function runDueTasks(
  app: Application,
  schedule: Schedule,
  at: Date = new Date(),
): Promise<void> {
  const evaluationErrors: ScheduleEvaluationError[] = [];
  const due = schedule.dueTasks(at, evaluationErrors);

  for (const { task, error } of evaluationErrors) {
    app.logger.error(`Scheduled task could not be evaluated: ${task.getDescription()}`, {
      cron: task.getCronExpression(),
      error: error.message,
      stack: error.stack,
    });
  }

  const locker = resolveLocker(app);

  const background: Promise<void>[] = [];

  for (const task of due) {
    if (task.runsInBackground()) {
      background.push(runTask(app, task, locker, at));
      continue;
    }

    await runTask(app, task, locker, at);
  }

  // `runTask()` never rejects, but `allSettled` keeps that a property of
  // this function rather than an assumption about that one.
  await Promise.allSettled(background);
}

/**
 * Builds the locker for this run: a `CacheScheduleLocker` when
 * `schedule.lockStore` names a cache store that can actually lock across
 * processes, otherwise the file-based `ScheduleLock`.
 *
 * Every failure path here falls back to files with a warning rather than
 * throwing. A misconfigured lock backend should degrade overlap prevention
 * to single-machine, not stop the schedule from running at all.
 */
function resolveLocker(app: Application): ScheduleLocker {
  const lockDirectory = app.config.get<string>("schedule.lockDirectory", "storage/schedule-locks");
  const files = new ScheduleLock(lockDirectory);

  const storeName = app.config.get<string | undefined>("schedule.lockStore", undefined);

  if (storeName === undefined) {
    return files;
  }

  if (!app.has(CACHE_TOKEN)) {
    app.logger.warning(
      `schedule.lockStore is set to "${storeName}" but no cache is registered — ` +
        `falling back to lock files. Register @mahiframework/cache's CacheServiceProvider.`,
    );

    return files;
  }

  let store: LockingCacheStore;
  try {
    store = app.make<{ store(name?: string): LockingCacheStore }>(CACHE_TOKEN).store(storeName);
  } catch (error) {
    app.logger.warning(
      `Could not resolve cache store "${storeName}" for schedule locking — using lock files.`,
      {
        error: (error as Error).message,
      },
    );

    return files;
  }

  // An in-memory store gives no exclusion at all between the separate
  // processes cron spawns, so it would turn overlap prevention into a
  // no-op that *looks* configured. Files are strictly better; say so.
  if (store.constructor?.name === "ArrayCacheStore") {
    app.logger.warning(
      `schedule.lockStore is set to "${storeName}", an in-memory store, which cannot lock across processes — ` +
        `using lock files instead. Point it at Redis to share overlap locks between hosts.`,
    );

    return files;
  }

  return new CacheScheduleLocker(store);
}

/**
 * Runs one task: filters, then lock, then the callback. Swallows
 * everything — see `runDueTasks()`.
 */
async function runTask(
  app: Application,
  task: ScheduledTask,
  locker: ScheduleLocker,
  at: Date,
): Promise<void> {
  // Skip tasks whose when()/skip() filters reject this run before
  // acquiring any lock — a filtered-out task never "ran".
  try {
    if (!(await task.filtersPass(app))) {
      return;
    }
  } catch (error) {
    app.logger.error(`Scheduled task filter failed: ${task.getDescription()}`, {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    return;
  }

  // Claimed before the overlap lock so a host that loses the race does
  // no further work, and — importantly — never takes the overlap lock it
  // would then have to release.
  const oneServerKey = task.getOneServerKey(at);

  if (oneServerKey !== undefined) {
    let claimed: boolean;
    try {
      claimed = await locker.acquire(oneServerKey, task.getOneServerExpiryMinutes() * 60_000);
    } catch (error) {
      app.logger.error(
        `Could not acquire the one-server lock for scheduled task: ${task.getDescription()}`,
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
        },
      );

      return;
    }

    if (!claimed) {
      // Another host has this tick. Not a warning: on a three-host
      // deployment two of them log this every single run, which would
      // make the signal worthless.
      app.logger.debug(`Task claimed by another server: ${task.getDescription()}`);

      return;
    }
  }

  const overlapKey = task.getOverlapKey();

  if (overlapKey !== undefined) {
    let acquired: boolean;
    try {
      acquired = await locker.acquire(overlapKey, task.getOverlapExpiryMinutes() * 60_000);
    } catch (error) {
      app.logger.error(
        `Could not acquire the overlap lock for scheduled task: ${task.getDescription()}`,
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
        },
      );

      return;
    }

    if (!acquired) {
      app.logger.warning(`Skipping overlapping task: ${task.getDescription()}`);

      return;
    }
  }

  try {
    await task.run(app);
  } catch (error) {
    app.logger.error(`Scheduled task failed: ${task.getDescription()}`, {
      error: (error as Error).message,
      // The stack is what makes a 3am failure diagnosable; the message
      // alone frequently isn't.
      stack: (error as Error).stack,
    });
    // deliberately does NOT rethrow — one failing task must not
    // block the run from evaluating/running the rest.
  } finally {
    if (overlapKey !== undefined) {
      try {
        await locker.release(overlapKey);
      } catch (error) {
        // A lock we can't release expires on its own; losing the whole
        // run over it would be worse.
        app.logger.error(
          `Could not release the overlap lock for scheduled task: ${task.getDescription()}`,
          {
            error: (error as Error).message,
          },
        );
      }
    }
  }
}
