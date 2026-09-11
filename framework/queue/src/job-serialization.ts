import type { Application } from "@mahi/core";
import { MODEL_REGISTRY_TOKEN, type ModelRegistry } from "@mahi/database";
import type { Job, JobClass } from "./job.js";
import { encodeModels, decodeModels } from "./model-serialization.js";

/**
 * A job's persisted state — a plain bag of the job instance's OWN
 * enumerable fields, with any `Model` field encoded to a `{ __model, __id }`
 * reference (see `model-serialization.ts`). This is what a durable driver
 * writes to `payload_json`; the job's class name is persisted separately
 * (see `QueuedJob.jobClass` / `JobRegistry`).
 */
export type JobState = Record<string, unknown>;

/**
 * Extracts a job instance's own enumerable fields into a serializable bag,
 * encoding any live `Model` (including inside arrays/objects/`Collection`s)
 * to a compact `{ __model, __id }` reference. `maxAttempts` and methods
 * (which live on the prototype, not as own fields) are intentionally not
 * captured — they're restored from the class on rebuild.
 *
 * A no-op passthrough of the raw field bag when the database package's
 * `ModelRegistry` isn't bound (a queue-only app/test with no models),
 * mirroring `decodeJob()`'s symmetric guard.
 */
export function encodeJob(app: Application, job: Job): JobState {
  const fields: JobState = { ...(job as unknown as Record<string, unknown>) };

  if (!app.has(MODEL_REGISTRY_TOKEN)) {
    return fields;
  }

  const registry = app.make<ModelRegistry>(MODEL_REGISTRY_TOKEN);

  return encodeModels(fields, registry) as JobState;
}

/**
 * Rebuilds a live job instance from its persisted state without re-running
 * the constructor: `Object.create(JobClass.prototype)` gives an instance
 * with the class's methods and prototype chain, then the decoded fields
 * (with `{ __model, __id }` references rehydrated back into live model
 * instances) are assigned onto it. Matches Laravel's queued-object
 * unserialization — the constructor ran once at dispatch, and its side
 * effects must not run again on the worker.
 *
 * `maxAttempts` is not part of the persisted state; the prototype's value
 * (the class default, or an own-field default set in the constructor and
 * captured by `encodeJob`) applies. If a job set `this.maxAttempts` in its
 * constructor, that value WAS captured as an own field and is restored here.
 */
export async function decodeJob(
  app: Application,
  JobClass: JobClass,
  state: JobState,
): Promise<Job> {
  const job = Object.create(JobClass.prototype) as Job;
  const fields = await decodeState(app, state);
  Object.assign(job, fields);

  return job;
}

/** Rehydrates model references in a persisted job state, or returns it unchanged. */
async function decodeState(app: Application, state: JobState): Promise<JobState> {
  if (!app.has(MODEL_REGISTRY_TOKEN)) {
    return state;
  }

  const registry = app.make<ModelRegistry>(MODEL_REGISTRY_TOKEN);

  return (await decodeModels(state, registry)) as JobState;
}
