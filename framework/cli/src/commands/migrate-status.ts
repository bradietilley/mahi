import { DatabaseManager, MigrationRunner, DATABASE_TOKEN } from "@mahi/database";
import { Tui, colors } from "@mahi/tui";
import { Command } from "../command.js";
import { collectMigrationSources } from "./migration-directories.js";

export class MigrateStatusCommand extends Command {
  signature = "migrate:status";
  description = "Show the status of every discovered migration.";

  async handle(): Promise<void> {
    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const runner = new MigrationRunner(db.driver().kysely, db.driver().dialect);
    const statuses = await runner.status(collectMigrationSources(this.app));

    if (statuses.length === 0) {
      Tui.info("No migrations found.");

      return;
    }

    Tui.table(
      ["Migration", "Status"],
      statuses.map((s) => [
        s.name,
        s.ran ? colors.green(`Ran (batch ${s.batch})`) : colors.yellow("Pending"),
      ]),
    );
  }
}
