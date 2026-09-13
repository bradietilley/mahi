import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { QUEUE_TOKEN } from "../tokens.js";
import { supportsFailedJobs } from "../failed-job-repository.js";

/**
 * `queue:failed`, list the rows in `failed_jobs` as a table, newest
 * first. Mirrors Laravel's `queue:failed`. Only the `database` connection
 * has durable failed-job storage; other drivers report so and exit.
 */
export class QueueFailedCommand extends Command {
  signature = "queue:failed";
  description = "List the jobs that have failed (in the failed_jobs table).";

  configure(program: CommanderCommand): void {
    program.option(
      "--connection <name>",
      "Queue connection to inspect (defaults to configured default)",
    );
  }

  async handle(options: { connection?: string }): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(options.connection);

    if (!supportsFailedJobs(driver)) {
      this.warn("The selected queue connection does not track failed jobs.");

      return;
    }

    const failed = await driver.listFailed();

    if (failed.length === 0) {
      this.info("No failed jobs.");

      return;
    }

    this.table(
      ["ID", "Job", "Failed At"],
      failed.map((f) => [f.id, f.jobClass, f.failedAt]),
    );
  }
}
