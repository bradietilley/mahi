import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahiframework/database";
import { Tui } from "@mahiframework/tui";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";

/**
 * `migrate:reset`, roll back every migration, newest batch first.
 *
 * The difference from `migrate:fresh` is which mechanism does the
 * emptying, and it matters: `reset` runs each migration's `down()`, while
 * `fresh` drops the tables outright and never calls one. So `reset`
 * exercises your `down()` methods, which is the point, since a `down()`
 * nobody runs is a `down()` nobody knows is broken, and correspondingly
 * fails on a migration whose `down()` is missing or wrong, where `fresh`
 * would not.
 */
export class MigrateResetCommand extends Command {
  signature = "migrate:reset";
  description = "Roll back every migration, running each one's down().";

  configure(program: CommanderCommand): void {
    program.option(
      "--pretend",
      "List the migrations that would roll back, without running them",
      false,
    );
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { pretend?: boolean; force?: boolean } = {}): Promise<void> {
    // Destructive: empties the whole schema. `--pretend` changes nothing,
    // so it skips the guard, same rule as migrate:rollback.
    if (!options.pretend && !(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
    const sources = collectMigrationSources(this.app);

    if (options.pretend) {
      const pending = await runner.reset(sources, undefined, { pretend: true });

      if (pending.length === 0) {
        Tui.info("Nothing to reset.");

        return;
      }

      Tui.info(`${pending.length} migration(s) would roll back:`);

      for (const name of pending) {
        Tui.note(`  ${name}`);
      }

      return;
    }

    const rolledBack = await runner.reset(sources, (name, run) => Tui.task(name, run));

    if (rolledBack.length === 0) {
      Tui.info("Nothing to reset.");
    }
  }
}
