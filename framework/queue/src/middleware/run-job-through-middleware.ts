import type { Application } from "@mahiframework/core";
import { Pipeline, type Pipe } from "@mahiframework/pipeline";
import type { Job } from "../job.js";
import type { JobMiddleware, JobMiddlewarePassable } from "./job-middleware.js";

/**
 * Runs `job.handle()` through the job's own `middleware()` stack (if any),
 * using `@mahiframework/pipeline` — the exact same composition Laravel's
 * `CallQueuedHandler` performs with its own `Pipeline`. Each `JobMiddleware`
 * wraps the eventual `handle()` call and may short-circuit (e.g. by
 * throwing `ReleaseJobError`) instead of calling `next()`.
 *
 * With no middleware this is just `await job.handle()` — zero overhead for
 * the common case. Shared by both `QueueWorkCommand` (durable drivers) and
 * `SyncQueueDriver` (inline execution) so middleware behaves identically
 * regardless of which driver runs the job.
 *
 * The job arrives already rebuilt with its fields rehydrated (models
 * decoded back to live instances) — see `decodeJob()` in the durable
 * worker; the sync driver passes the live instance straight through.
 */
export async function runJobThroughMiddleware(app: Application, job: Job): Promise<void> {
  const middleware = job.middleware?.() ?? [];

  const passable: JobMiddlewarePassable = { app, job };

  if (middleware.length === 0) {
    await job.handle();

    return;
  }

  const pipes: Array<Pipe<JobMiddlewarePassable, void>> = middleware.map(
    (m: JobMiddleware) => (p, next) => m.handle(p, (next2) => Promise.resolve(next(next2))),
  );

  await new Pipeline<JobMiddlewarePassable, void>()
    .send(passable)
    .through(pipes)
    .run(async (p) => {
      await p.job.handle();
    });
}
