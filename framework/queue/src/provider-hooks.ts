import type { JobClass } from "./job.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Return job-name -> `JobClass` pairs this provider contributes.
     * Collected during the queue package's own ServiceProvider boot, after
     * every provider's register() has run, same pattern as `listeners()`
     * from `@mahiframework/events`.
     */
    jobs?(): Record<string, JobClass>;
  }
}
