import type { Job, JobClass } from "./job.js";

/**
 * Maps a job name (a stable string, safe to persist to disk and survive
 * across process restarts) to the `JobClass` that implements it, and back.
 *
 * Jobs are dispatched by INSTANCE (`Bus.dispatch(new SomeJob(...))`) but
 * still travel through a driver as a persisted `{ jobClass: name, state }`
 * pair — so dispatch needs the name for a given job's class (`nameFor`),
 * and the worker needs the class for a persisted name (`resolve`) to
 * rebuild the instance. See `Job`'s docstring for the full lifecycle.
 */
export class JobRegistry {
  private classes = new Map<string, JobClass>();
  private names = new Map<JobClass, string>();

  register(name: string, jobClass: JobClass): void {
    this.classes.set(name, jobClass);
    this.names.set(jobClass, name);
  }

  resolve(name: string): JobClass {
    const cls = this.classes.get(name);

    if (!cls) {
      throw new Error(`Job [${name}] is not registered.`);
    }

    return cls;
  }

  /**
   * The registered name for a job (given the instance or its class).
   * Throws if the job's class was never registered via a provider's
   * `jobs()` hook — you can't dispatch a job the queue can't later
   * reconstruct by name in a worker process.
   */
  nameFor(job: Job | JobClass): string {
    const jobClass = (typeof job === "function" ? job : job.constructor) as JobClass;
    const name = this.names.get(jobClass);

    if (!name) {
      const className = (jobClass as { name?: string }).name ?? "anonymous";
      throw new Error(
        `Job [${className}] is not registered. Register it via a provider's ` +
          `jobs() hook so it can be dispatched and reconstructed by name.`,
      );
    }

    return name;
  }

  has(name: string): boolean {
    return this.classes.has(name);
  }
}
