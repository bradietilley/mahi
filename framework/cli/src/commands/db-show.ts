import { DatabaseManager, DATABASE_TOKEN } from "@mahi/database";
import { Tui } from "@mahi/tui";
import { Command } from "../command.js";

/**
 * `db:show` — a connection/table overview, mirroring Laravel's
 * `ShowCommand`. Backed by Kysely's own `introspection.getTables()`
 * (already used by `MigrationRunner` internally), so this packages an
 * existing capability as a CLI command rather than building new
 * introspection machinery.
 */
export class DbShowCommand extends Command {
  signature = "db:show";
  description = "Show an overview of the database: driver + every table and its row count.";

  async handle(): Promise<void> {
    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const { kysely } = db.driver();

    const tables = await kysely.introspection.getTables();

    if (tables.length === 0) {
      Tui.info("No tables found.");

      return;
    }

    const rows: (string | number)[][] = [];

    for (const table of tables) {
      const result = await kysely
        .selectFrom(table.name as never)
        .select((eb: any) => eb.fn.countAll().as("count"))
        .executeTakeFirst();
      const count = Number((result as { count?: unknown } | undefined)?.count ?? 0);
      rows.push([table.name, table.columns.length, count]);
    }

    Tui.table(["Table", "Columns", "Rows"], rows);
  }
}
