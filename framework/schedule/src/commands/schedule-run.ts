import { Command } from "@mahi/cli";
import { Schedule } from "../schedule.js";
import { SCHEDULE_TOKEN } from "../tokens.js";
import { runDueTasks } from "../run-due-tasks.js";

export class ScheduleRunCommand extends Command {
  signature = "schedule:run";
  description = "Run any scheduled tasks that are due right now.";

  async handle(): Promise<void> {
    const schedule = this.app.make<Schedule>(SCHEDULE_TOKEN);
    await runDueTasks(this.app, schedule);
  }
}
