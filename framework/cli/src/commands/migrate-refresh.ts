import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahi/database";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";
import { DbSeedCommand } from "./db-seed.js";
import { Tui } from "@mahi/tui";

export class MigrateRefreshCommand extends Command {
  signature = "migrate:refresh";
  description = "Roll back every migration batch, then re-run every migration.";

  configure(program: CommanderCommand): void {
    program.option("--seed", "Run database seeders after migrating", false);
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { seed?: boolean; force?: boolean } = {}): Promise<void> {
    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
    const sources = collectMigrationSources(this.app);

    // One `reset()` rather than a `do/while` over `rollback()`: it walks
    // every batch inside a single lock acquisition, so a concurrent
    // `migrate` cannot interleave between batches.
    await runner.reset(sources, (name, run) => Tui.task(name, run));

    const ran = await runner.up(sources, (name, run) => Tui.task(name, run));

    if (ran.length === 0) {
      Tui.warning("Nothing to migrate.");
    }

    if (options.seed) {
      // Already confirmed above for the whole operation — do not prompt twice.
      await new DbSeedCommand(this.app).handle({ force: true });
    }
  }
}
