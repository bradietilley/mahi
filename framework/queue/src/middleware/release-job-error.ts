/**
 * A control-flow sentinel a job middleware throws to say "put this job back
 * on the queue to try again in `delaySeconds`" — as distinct from a real
 * failure (any other thrown error), which counts against `maxAttempts` and
 * eventually lands in `failed_jobs`.
 *
 * `QueueWorkCommand.processJob()` special-cases this before its normal
 * attempts/backoff logic: a release does **not** increment the failure
 * count toward `maxAttempts` in the "give up" sense — it simply reschedules
 * (`driver.release()` still bumps the row's `attempts`, mirroring Laravel's
 * `release()`, but the job is never routed to `failed_jobs` on a release).
 *
 * This is what `RateLimited` (limit exceeded) and `WithoutOverlapping`
 * (couldn't get the lock) throw instead of failing — the work isn't wrong,
 * it just shouldn't run *right now*.
 */
export class ReleaseJobError extends Error {
  constructor(public readonly delaySeconds: number = 0) {
    super(`Job released back onto the queue (retry in ${delaySeconds}s).`);
    this.name = "ReleaseJobError";
  }
}
