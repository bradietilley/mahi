import type { Command as CommanderCommand } from "commander";
import { DatabaseManager, SchemaBuilder, DATABASE_TOKEN } from "@mahi/database";
import { Tui } from "@mahi/tui";
import { Command } from "../command.js";

/**
 * `db:wipe` — drop every table and stop.
 *
 * `migrate:fresh` without the re-migrate: it leaves an empty schema, with
 * no migrations table and so no record that anything ever ran. Useful
 * before restoring a dump, or when the migration history itself is what
 * you want gone.
 *
 * The most destructive command here, and unlike `migrate:reset` there is
 * no `down()` involved — the tables are dropped directly, so nothing in
 * the migrations can object.
 */
export class DbWipeCommand extends Command {
  signature = "db:wipe";
  description = "Drop every table in the database, leaving it empty.";

  configure(program: CommanderCommand): void {
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { force?: boolean } = {}): Promise<void> {
    if (!(await this.confirmToProceed(options))) {
      return;
    }

    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const builder = new SchemaBuilder(db.driver().kysely, db.driver().dialect);

    await Tui.task("Dropping all tables", () => builder.dropAllTables());

    Tui.success("Database wiped.");
  }
}
