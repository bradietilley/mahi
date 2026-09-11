import type { Schedule } from "./schedule.js";

declare module "@mahi/core" {
  interface ProviderHooks {
    /**
     * Register recurring tasks onto the given Schedule. Collected during
     * the schedule package's own ServiceProvider boot, after every
     * provider's register() has run.
     */
    schedule?(schedule: Schedule): void;
  }
}
