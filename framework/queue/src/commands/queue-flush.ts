import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { QUEUE_TOKEN } from "../tokens.js";
import { supportsFailedJobs } from "../failed-job-repository.js";

/**
 * `queue:flush` — bulk-delete failed jobs, optionally only those older than
 * `--hours <n>`. Mirrors Laravel's `queue:flush` (whose `--hours` option
 * prunes by age).
 *
 * Guarded in production by `confirmToProceed()`. The `failed_jobs` table is
 * the forensic record of every job that has ever broken — the thing you
 * read *after* an incident to find out what happened — so an unattended
 * `queue:flush` destroys evidence, not just rows. `--hours` narrows the
 * blast radius but does not remove the need to confirm.
 */
export class QueueFlushCommand extends Command {
  signature = "queue:flush";
  description = "Delete all failed jobs (or only those older than --hours).";

  configure(program: CommanderCommand): void {
    program.option(
      "--connection <name>",
      "Queue connection to operate on (defaults to configured default)",
    );
    program.option("--hours <n>", "Only delete failed jobs older than this many hours");
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { connection?: string; hours?: string; force?: boolean }): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(options.connection);

    if (!supportsFailedJobs(driver)) {
      this.warn("The selected queue connection does not track failed jobs.");

      return;
    }

    const olderThanHours = options.hours !== undefined ? Number(options.hours) : undefined;

    if (olderThanHours !== undefined && (!Number.isFinite(olderThanHours) || olderThanHours < 0)) {
      this.error(`Invalid --hours value: "${options.hours}".`);

      return;
    }

    // After the argument check, so a typo'd --hours fails fast rather than
    // prompting for a run that was never going to work.
    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const removed = await driver.flush(olderThanHours);
    this.info(`Flushed ${removed} failed job${removed === 1 ? "" : "s"}.`);
  }
}
