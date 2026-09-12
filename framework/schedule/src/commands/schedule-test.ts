import { Command } from "@mahiframework/cli";
import { Tui } from "@mahiframework/tui";
import { Schedule } from "../schedule.js";
import { SCHEDULE_TOKEN } from "../tokens.js";

export class ScheduleTestCommand extends Command {
  signature = "schedule:test";
  description = "Interactively pick one scheduled task and run it immediately.";

  async handle(): Promise<void> {
    const schedule = this.app.make<Schedule>(SCHEDULE_TOKEN);
    const tasks = schedule.all();

    if (tasks.length === 0) {
      Tui.info("No scheduled tasks registered.");

      return;
    }

    // Map each task to its (index-disambiguated) description so two tasks
    // sharing a description remain individually selectable.
    const options: Record<string, string> = {};
    tasks.forEach((task, index) => {
      options[String(index)] = task.getDescription();
    });

    const selected = await Tui.select("Which task would you like to run?", { options });
    const task = tasks[Number(selected)]!;

    Tui.info(`Running scheduled task: ${task.getDescription()}`);
    try {
      await task.run(this.app);
      Tui.success(`Task complete: ${task.getDescription()}`);
    } catch (error) {
      Tui.error(`Task failed: ${(error as Error).message}`);
    }
  }
}
