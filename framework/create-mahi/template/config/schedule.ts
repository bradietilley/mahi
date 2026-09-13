export interface ScheduleConfig {
  /** Directory for `withoutOverlapping()`'s lock files. Relative to the working directory. */
  lockDirectory: string;

  /**
   * Name of a cache store to hold `withoutOverlapping()` locks in, instead
   * of lock files.
   *
   * Lock *files* are local to one machine, so two hosts running the
   * scheduler each take their own copy of "the" lock and both run the
   * task. Point this at a store that is shared and atomic across
   * processes, Redis, and the lock becomes global, which is what makes
   * running the scheduler on more than one host safe.
   *
   * Leave it unset for the usual single-host deployment. An in-memory
   * store is rejected (it cannot lock across the processes cron spawns)
   * and falls back to files with a warning.
   */
  lockStore?: string;

  /**
   * Whole-exchange timeout, in milliseconds, for `pingBefore()` /
   * `thenPing()` / `pingOnSuccess()` / `pingOnFailure()` webhooks.
   *
   * Pings run between the scheduler and the task's work, so a monitoring
   * endpoint that accepts the connection and then goes quiet would stall
   * the whole tick without a bound. Raise it only if your monitoring
   * service is genuinely slow.
   */
  pingTimeoutMs?: number;
}

export function scheduleConfig(): ScheduleConfig {
  return {
    lockDirectory: "storage/schedule-locks",
    // lockStore: "redis",
    pingTimeoutMs: 5_000,
  };
}
