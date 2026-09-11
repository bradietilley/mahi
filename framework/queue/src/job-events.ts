import { AbstractEvent } from "@mahi/events";
import type { Job } from "./job.js";
import type { QueuedJob } from "./queue-driver.js";

/**
 * Queue lifecycle events, dispatched by the `queue:work` worker through
 * `@mahi/events` (when an `EventsServiceProvider` is registered) so
 * app code — error reporting, a monitoring page, metrics — can react to
 * job progress without editing the worker. Analogous to Laravel's
 * `JobProcessing`/`JobProcessed`/`JobFailed`.
 *
 * Each carries the connection name, the rebuilt live `Job` instance, and
 * the raw `QueuedJob` record (id, attempts, jobClass). `JobFailed` also
 * carries the error that exhausted the job.
 *
 * Fire-and-forget: a listener that itself throws must not derail the
 * worker, so the worker dispatches these defensively (see `queue-work.ts`).
 */
export class JobProcessing extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
  ) {
    super();
  }
}

export class JobProcessed extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
  ) {
    super();
  }
}

export class JobFailed extends AbstractEvent {
  constructor(
    public readonly connection: string | undefined,
    public readonly job: Job,
    public readonly queued: QueuedJob,
    public readonly error: Error,
  ) {
    super();
  }
}
