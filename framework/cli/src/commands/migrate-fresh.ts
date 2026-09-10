import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahi/database";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";
import { DbSeedCommand } from "./db-seed.js";
import { Tui } from "@mahi/tui";

export class MigrateFreshCommand extends Command {
  signature = "migrate:fresh";
  description = "Drop all tables and re-run every migration from scratch.";

  configure(program: CommanderCommand): void {
    program.option("--seed", "Run database seeders after migrating", false);
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { seed?: boolean; force?: boolean } = {}): Promise<void> {
    // The most destructive command in the framework: it drops every
    // table outright, without going through any migration's `down()`.
    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
    const ran = await runner.fresh(collectMigrationSources(this.app), (name, run) =>
      Tui.task(name, run),
    );

    if (ran.length === 0) {
      Tui.warning("Nothing to migrate.");
    }

    if (options.seed) {
      // Already confirmed above for the whole operation — do not prompt twice.
      await new DbSeedCommand(this.app).handle({ force: true });
    }
  }
}
