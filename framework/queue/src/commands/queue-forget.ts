import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { QUEUE_TOKEN } from "../tokens.js";
import { supportsFailedJobs } from "../failed-job-repository.js";

/**
 * `queue:forget <id>` — delete a single failed job by id without retrying
 * it. Mirrors Laravel's `queue:forget`.
 */
export class QueueForgetCommand extends Command {
  signature = "queue:forget <id>";
  description = "Delete a single failed job by id.";

  configure(program: CommanderCommand): void {
    program.option(
      "--connection <name>",
      "Queue connection to operate on (defaults to configured default)",
    );
  }

  async handle(id: string, options: { connection?: string }): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(options.connection);

    if (!supportsFailedJobs(driver)) {
      this.warn("The selected queue connection does not track failed jobs.");

      return;
    }

    const ok = await driver.forget(id);

    if (ok) {
      this.info(`Failed job ${id} deleted.`);
    } else {
      this.error(`No failed job with id ${id}.`);
    }
  }
}
