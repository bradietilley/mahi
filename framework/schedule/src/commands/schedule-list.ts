import { Command } from "@mahi/cli";
import { Tui, colors } from "@mahi/tui";
import { Schedule } from "../schedule.js";
import { SCHEDULE_TOKEN } from "../tokens.js";
import { formatNextRun } from "../scheduled-task.js";

export class ScheduleListCommand extends Command {
  signature = "schedule:list";
  description = "List every registered scheduled task.";

  async handle(): Promise<void> {
    const schedule = this.app.make<Schedule>(SCHEDULE_TOKEN);
    const tasks = schedule.all();

    if (tasks.length === 0) {
      Tui.info("No scheduled tasks registered.");

      return;
    }

    Tui.table(
      ["Cron", "Description", "Next Due"],
      tasks.map((task) => {
        const zone = task.getTimezone();
        // Rendered in the task's own zone, and labelled with it: a
        // `timezone("Asia/Tokyo")` task's next run shown on a UTC server's
        // clock is a number nobody can check against the expression they
        // wrote.
        const nextDue = formatNextRun(task.nextRunAt(), zone);

        return [
          colors.yellow(task.getCronExpression()),
          task.getDescription(),
          colors.gray(zone ? `${nextDue} ${zone}` : nextDue),
        ];
      }),
    );
  }
}
