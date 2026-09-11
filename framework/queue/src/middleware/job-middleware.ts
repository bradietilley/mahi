import type { Application } from "@mahi/core";
import type { Job } from "../job.js";

/**
 * The passable threaded through a job's middleware pipeline — the running
 * `Application` plus the live job instance (whose fields carry the
 * payload). Middleware read/act on these and then either call `next()` to
 * continue toward `job.handle()` or throw a {@link ReleaseJobError} to bail
 * out and reschedule the job.
 */
export interface JobMiddlewarePassable {
  app: Application;
  job: Job;
}

/**
 * A single job middleware — wraps the eventual call to `job.handle()`,
 * exactly like an HTTP middleware wraps the eventual call to a route
 * handler. Call `next(passable)` to proceed; skip it (or throw
 * {@link ReleaseJobError}) to short-circuit.
 *
 * Modelled as a `@mahi/pipeline` `PipeObject`, so `Job.middleware()`
 * results compose straight into a `Pipeline` in `QueueWorkCommand`/
 * `SyncQueueDriver` with no adapter layer — see `runJobThroughMiddleware`.
 */
export interface JobMiddleware {
  handle(
    passable: JobMiddlewarePassable,
    next: (passable: JobMiddlewarePassable) => Promise<void>,
  ): Promise<void>;
}
