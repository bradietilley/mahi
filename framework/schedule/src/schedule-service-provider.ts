import { ServiceProvider } from "@mahiframework/core";
import { Schedule } from "./schedule.js";
import { ScheduleRunCommand } from "./commands/schedule-run.js";
import { ScheduleListCommand } from "./commands/schedule-list.js";
import { ScheduleTestCommand } from "./commands/schedule-test.js";
import { ScheduleWorkCommand } from "./commands/schedule-work.js";
import { SCHEDULE_TOKEN } from "./tokens.js";

export { SCHEDULE_TOKEN };

/**
 * Registers the Schedule singleton and, during boot, collects every
 * provider's `schedule()` hook (all providers are already instantiated by
 * this point, regardless of boot order), same collection pattern
 * `EventsServiceProvider` uses for `listeners()`.
 *
 * Contributes the `schedule:run`/`schedule:list`/`schedule:test`/
 * `schedule:work` CLI commands.
 */
export class ScheduleServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(SCHEDULE_TOKEN, (app) => new Schedule(app));
  }

  boot(): void {
    const schedule = this.app.make<Schedule>(SCHEDULE_TOKEN);

    for (const provider of this.app.getProviders()) {
      provider.schedule?.(schedule);
    }

    // Every provider has contributed, so the schedule is complete and can
    // be checked as a whole. Failing here, at boot, loudly, is the point:
    // an unnamed `withoutOverlapping()` task or a duplicated name is a
    // silent "task mysteriously never runs" in production otherwise, and
    // the mistake is in code that has just been deployed.
    schedule.validate();
  }

  commands() {
    return [ScheduleRunCommand, ScheduleListCommand, ScheduleTestCommand, ScheduleWorkCommand];
  }
}
