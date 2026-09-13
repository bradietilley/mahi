import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { QUEUE_TOKEN } from "../tokens.js";
import { supportsFailedJobs } from "../failed-job-repository.js";

/**
 * `queue:retry <id...>`, push failed jobs back onto the live queue, with
 * `attempts` reset to 0 and their failed-jobs rows removed. `--all` retries
 * every failed job. Mirrors Laravel's `queue:retry`.
 */
export class QueueRetryCommand extends Command {
  signature = "queue:retry [ids...]";
  description = "Retry one or more failed jobs (push them back onto the queue).";

  configure(program: CommanderCommand): void {
    program.option(
      "--connection <name>",
      "Queue connection to operate on (defaults to configured default)",
    );
    program.option("--all", "Retry every failed job");
  }

  async handle(ids: string[] = [], options: { connection?: string; all?: boolean }): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(options.connection);

    if (!supportsFailedJobs(driver)) {
      this.warn("The selected queue connection does not track failed jobs.");

      return;
    }

    let targets = ids;

    if (options.all) {
      targets = (await driver.listFailed()).map((f) => f.id);
    }

    if (targets.length === 0) {
      this.warn("No job ids given. Pass ids or --all.");

      return;
    }

    for (const id of targets) {
      const ok = await driver.retry(id);

      if (ok) {
        this.info(`Job ${id} pushed back onto the queue.`);
      } else {
        this.error(`No failed job with id ${id}.`);
      }
    }
  }
}
