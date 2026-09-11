import type { ChainedJob } from "./queue-driver.js";

/**
 * A single row in `failed_jobs` — a job that exhausted `maxAttempts` (or
 * whose class couldn't be resolved). `error` holds the full stack trace
 * when one was available at failure time.
 */
export interface FailedJobRecord {
  id: string;
  jobClass: string;
  /** The serialized job-instance fields, as stored — parsed lazily by callers. */
  payloadJson: string;
  error: string;
  failedAt: string;
  /** The connection the job was running on, when the store recorded one. */
  connection?: string;
  /** The named queue the job failed on — where `retry()` puts it back. */
  queue?: string;
  /**
   * The chain the job was carrying when it failed, restored by `retry()`.
   * Absent for an unchained job (and for stores that predate chain
   * persistence).
   */
  chain?: ChainedJob[];
}

/**
 * Operational surface over the `failed_jobs` store, backing the
 * `queue:failed`/`queue:retry`/`queue:forget`/`queue:flush` commands.
 * Implemented by `DatabaseQueueDriver` and `RedisQueueDriver`; the `sync`
 * driver rethrows on failure and never records anything, so it does not
 * implement this.
 *
 * `retry()` pushes the stored payload back onto the queue it failed on,
 * with `attempts` reset to 0 and its chain restored, then removes the
 * failed-jobs record — matching Laravel's `queue:retry`.
 */
export interface FailedJobRepository {
  listFailed(): Promise<FailedJobRecord[]>;
  findFailed(id: string): Promise<FailedJobRecord | undefined>;
  retry(id: string): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  /** Delete failed jobs older than `olderThanHours` (all of them if omitted). Returns the count removed. */
  flush(olderThanHours?: number): Promise<number>;
}

/** Narrowing guard — whether a resolved driver exposes failed-job tooling. */
export function supportsFailedJobs(driver: unknown): driver is FailedJobRepository {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as FailedJobRepository).listFailed === "function"
  );
}
