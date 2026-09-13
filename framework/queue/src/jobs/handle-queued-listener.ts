import { app } from "@mahiframework/core";
import { EventDispatcher, EVENTS_TOKEN, type QueuedListenerPayload } from "@mahiframework/events";
import { Job } from "../job.js";

/**
 * Built-in job that rehydrates a `listenQueued()` registration and runs
 * the original listener. Dispatched by the handler `QueueServiceProvider`
 * installs on `EventDispatcher`, not intended to be dispatched by
 * application code directly.
 *
 * The `QueuedListenerPayload` (a plain serializable `{ id, data }` object)
 * is carried as a constructor field, so it survives the same
 * serialize/rebuild round-trip as any other job's fields.
 */
export class HandleQueuedListener extends Job {
  constructor(public readonly payload: QueuedListenerPayload) {
    super();
  }

  async handle(): Promise<void> {
    const dispatcher = app().make<EventDispatcher>(EVENTS_TOKEN);
    await dispatcher.runQueuedListener(this.payload);
  }
}

export const QUEUED_LISTENER_JOB = "events.handle-queued-listener";
