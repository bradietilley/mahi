import type { Application } from "@mahiframework/core";
import { afterCommit } from "@mahiframework/database";
import type { JobRegistry } from "../job-registry.js";
import type { QueueDriver, QueuedJob, PushOptions } from "../queue-driver.js";
import type { JobState } from "../job-serialization.js";
import { decodeJob } from "../job-serialization.js";
import { runJobThroughMiddleware } from "../middleware/run-job-through-middleware.js";
import { SkipJobMissingModelError } from "../model-serialization.js";
import { uniqueModeOf } from "../job.js";
import { acquireUniqueLockForState, releaseUniqueLock } from "../unique-jobs.js";

/**
 * Runs jobs immediately, inline, no persistence, the queue equivalent of
 * `ArrayCacheStore`: correct, zero infra, ideal default for dev/tests.
 * Matches Laravel's own `sync` driver semantics exactly: "dispatch" and
 * "execute" are the same call, so `push()` completes only once the job's
 * `handle()` has finished running (or thrown). There is no separate
 * `pop()`/worker loop involved at all, `pop()` always returns `undefined`,
 * since nothing is ever queued for later.
 */
export class SyncQueueDriver implements QueueDriver {
  constructor(
    private app: Application,
    private registry: JobRegistry,
  ) {}

  async push(jobClass: string, state: JobState, options: PushOptions = {}): Promise<void> {
    const JobClass = this.registry.resolve(jobClass);
    // Rebuild the live job from its serialized state, the same round-trip
    // the durable worker performs (models rehydrated), so a job behaves
    // identically under `sync` as under `database`, and any `Model` fields
    // are freshly loaded rather than the stale dispatch-time instances. A
    // model whose class opted into `deleteWhenMissingModels` and no longer
    // exists throws `SkipJobMissingModelError`, swallow it so the job is
    // treated as completed (skipped), matching the durable worker.
    let job;
    try {
      job = await decodeJob(this.app, JobClass, state);
    } catch (error) {
      if (error instanceof SkipJobMissingModelError) {
        // The referenced model is gone, treat as completed and free the
        // uniqueness lock so a fresh instance can be queued.
        await this.releaseUnique(jobClass, JobClass, state, "untilFinished");

        return;
      }

      throw error;
    }

    const mode = uniqueModeOf(job);

    // `untilProcessing` frees the lock the instant work starts, so a new
    // instance can be queued while this one runs.
    if (mode === "untilProcessing") {
      await releaseUniqueLock(this.app, jobClass, job);
    }

    // Run through the job's middleware (if any), exactly as the durable
    // worker does, so `RateLimited`/`WithoutOverlapping` behave the same
    // under `sync`. A middleware-triggered `ReleaseJobError` surfaces to
    // the caller here, since sync has no queue to release back onto.
    try {
      await runJobThroughMiddleware(this.app, job);
    } catch (error) {
      // A throwing sync job is terminal (no retries here), release the
      // `untilFinished` lock so the failure doesn't block re-dispatch.
      if (mode === "untilFinished") {
        await releaseUniqueLock(this.app, jobClass, job);
      }

      throw error;
    }

    // Success, free the `untilFinished` lock now the job has finished.
    if (mode === "untilFinished") {
      await releaseUniqueLock(this.app, jobClass, job);
    }

    // "dispatch = execute" extends to chains: run the next link inline
    // once the current one succeeds, carrying the remainder forward.
    //
    // Each link takes its own uniqueness lock, as it would have if it had
    // been dispatched directly, only the head of a chain goes through
    // `QueueManager.dispatch()`. A held lock drops the link (and the rest
    // of the chain riding on it), matching the durable worker.
    if (options.chain && options.chain.length > 0) {
      const [next, ...rest] = options.chain;

      if (next) {
        const NextClass = this.registry.resolve(next.jobClass);
        const acquired = await acquireUniqueLockForState(
          this.app,
          next.jobClass,
          NextClass,
          next.state,
        );

        if (acquired) {
          await this.push(next.jobClass, next.state, { chain: rest });
        }
      }
    }
  }

  /**
   * Release a unique job's lock when the live instance couldn't be built
   * (a missing model). Rebuilds a bare prototype instance purely so
   * `releaseUniqueLock` can read `uniqueId()`/`uniqueVia()`/`uniqueFor()`
   * and `static unique` off it, the same key the dispatcher locked.
   */
  private async releaseUnique(
    jobClass: string,
    JobClass: ReturnType<JobRegistry["resolve"]>,
    state: JobState,
    _mode: "untilFinished",
  ): Promise<void> {
    const bare = Object.assign(Object.create(JobClass.prototype), state);

    if (uniqueModeOf(bare) === undefined) {
      return;
    }

    await releaseUniqueLock(this.app, jobClass, bare);
  }

  /**
   * Runs the job once the enclosing transaction commits, or immediately
   * outside one, so `{ afterCommit: true }` means the same thing under
   * `sync` as under a durable driver, and a job dispatched in a
   * transaction that rolls back never runs here either.
   *
   * Note this makes `await Bus.dispatch(...)` resolve *before* the job has
   * run when a transaction is open, unlike the usual sync guarantee: the
   * job cannot run until the transaction it is waiting on commits, and
   * that commit happens after the dispatching code returns.
   */
  async pushAfterCommit(
    jobClass: string,
    state: JobState,
    options: PushOptions = {},
  ): Promise<void> {
    await afterCommit(() => this.push(jobClass, state, options));
  }

  async pop(): Promise<QueuedJob | undefined> {
    return undefined;
  }

  async release(): Promise<void> {
    // No-op: sync jobs never end up queued in the first place, so there's
    // never anything to release for a later retry.
  }

  async delete(): Promise<void> {
    // No-op. See release().
  }

  async fail(): Promise<void> {
    // No-op, a throwing sync job surfaces its error directly to the
    // caller of push(); there is no failed_jobs table for this driver.
  }
}
