import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahi/database";
import { Tui } from "@mahi/tui";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";

export class MigrateRollbackCommand extends Command {
  signature = "migrate:rollback";
  description = "Roll back the most recent migration batch.";

  configure(program: CommanderCommand): void {
    program.option("--step <count>", "Number of batches to roll back (default: 1)");
    program.option(
      "--pretend",
      "List the migrations that would roll back, without running them",
      false,
    );
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { step?: string; pretend?: boolean; force?: boolean } = {}): Promise<void> {
    if (!options.pretend && !(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
    const sources = collectMigrationSources(this.app);

    // A garbage `--step` falls back to the default rather than becoming
    // `NaN`, which would silently roll back nothing.
    const parsed = Number(options.step);
    const step = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

    if (options.pretend) {
      const pending = await runner.rollback(sources, undefined, { pretend: true, step });

      if (pending.length === 0) {
        Tui.info("Nothing to roll back.");

        return;
      }

      Tui.info(`${pending.length} migration(s) would roll back:`);

      for (const name of pending) {
        Tui.note(`  ${name}`);
      }

      return;
    }

    const rolledBack = await runner.rollback(sources, (name, run) => Tui.task(name, run), { step });

    if (rolledBack.length === 0) {
      Tui.info("Nothing to roll back.");
    }
  }
}
