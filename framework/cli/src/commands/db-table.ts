import { DatabaseManager, DATABASE_TOKEN } from "@mahiframework/database";
import { Tui, colors } from "@mahiframework/tui";
import { Command } from "../command.js";

/**
 * `db:table <table>` — column detail for one table (name, type,
 * nullability, auto-increment), mirroring Laravel's `TableCommand`.
 * Backed by Kysely's `introspection.getTables()`, same as `db:show`.
 */
export class DbTableCommand extends Command {
  signature = "db:table <table>";
  description = "Show the columns of a single table.";

  async handle(tableName: string): Promise<void> {
    const db = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const { kysely } = db.driver();

    const tables = await kysely.introspection.getTables();
    const table = tables.find((t) => t.name === tableName);

    if (!table) {
      Tui.error(`Table "${tableName}" not found.`);

      return;
    }

    Tui.table(
      ["Column", "Type", "Nullable", "Auto-increment"],
      table.columns.map((column) => [
        column.name,
        column.dataType,
        column.isNullable ? colors.yellow("yes") : "no",
        column.isAutoIncrementing ? colors.green("yes") : "no",
      ]),
    );
  }
}
