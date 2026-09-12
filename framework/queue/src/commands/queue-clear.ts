import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { QueueManager } from "../queue-manager.js";
import { QUEUE_TOKEN } from "../tokens.js";
import { supportsClearing } from "../queue-driver.js";

/**
 * `queue:clear` — delete every pending job on a queue without running it.
 *
 * Destructive and irreversible: the jobs are gone, not failed, so nothing
 * records that they existed. It exists for the case where a bad deploy
 * enqueued a mountain of work that must not run — the alternative being
 * to let workers grind through it or to hand-write DELETE statements.
 *
 * Confirmation goes through `confirmToProceed()`, the same guard the
 * migration commands use. A bare `confirm()` would not do: a prompt with
 * no TTY resolves to its default rather than blocking, so an unattended
 * production run would delete every pending job silently and exit 0.
 */
export class QueueClearCommand extends Command {
  signature = "queue:clear";
  description = "Delete all pending jobs on a queue (destructive).";

  configure(program: CommanderCommand): void {
    program.option(
      "--connection <name>",
      "Queue connection to clear (defaults to configured default)",
    );
    program.option("--queue <name>", "Named queue to clear (defaults to the connection's own)");
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { connection?: string; queue?: string; force?: boolean }): Promise<void> {
    const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
    const driver = manager.connection(options.connection);

    if (!supportsClearing(driver)) {
      this.warn("The selected queue connection has no pending jobs to clear.");

      return;
    }

    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const removed = await driver.clear(options.queue);
    this.info(`Deleted ${removed} pending job${removed === 1 ? "" : "s"}.`);
  }
}
