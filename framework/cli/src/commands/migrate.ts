import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahiframework/database";
import { Tui } from "@mahiframework/tui";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";

export class MigrateCommand extends Command {
  signature = "migrate";
  description = "Run all pending migrations.";

  configure(program: CommanderCommand): void {
    program.option("--pretend", "List the migrations that would run, without running them", false);
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { pretend?: boolean; force?: boolean } = {}): Promise<void> {
    // `--pretend` changes nothing, so it needs no production guard,
    // being able to check what a deploy *would* do, on production,
    // without ceremony is the point of it.
    if (!options.pretend && !(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);

    if (options.pretend) {
      const pending = await runner.up(collectMigrationSources(this.app), undefined, {
        pretend: true,
      });

      if (pending.length === 0) {
        Tui.info("Nothing to migrate.");

        return;
      }

      Tui.info(`${pending.length} migration(s) would run:`);

      for (const name of pending) {
        Tui.note(`  ${name}`);
      }

      return;
    }

    const ran = await runner.up(collectMigrationSources(this.app), (name, run) =>
      Tui.task(name, run),
    );

    if (ran.length === 0) {
      Tui.info("Nothing to migrate.");
    }
  }
}
