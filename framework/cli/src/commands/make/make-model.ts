import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";
import { MakeMigrationCommand, type KeyType } from "../make-migration.js";
import { MakeFactoryCommand } from "./make-factory.js";

/**
 * The primary-key style a generated model uses. This one choice drives all
 * three generated files consistently (`make:model -m -f`):
 *
 * - `id`        — DB auto-increment `bigint` (Laravel's default). `id: number`,
 *   `keyType` left at its `"increment"` default, `table.id()`, and the
 *   factory omits `id` (the DB assigns it on insert).
 * - `uuid`      — client-generated UUID string. `id: string`,
 *   `keyType: "uuid"`, `table.string("id").primary()`, factory omits `id`.
 * - `snowflake` — client-generated Snowflake. `id: string`,
 *   `keyType: snowflake()` (from `@mahi/snowflake`),
 *   `table.string("id").primary()`, factory omits `id`.
 *
 * The model, migration and factory a single `make:model -m -f` emits must
 * agree on one strategy; mixing them fails at `create()` with a datatype
 * mismatch.
 */
export type ModelKeyType = KeyType;

function idType(keyType: ModelKeyType): string {
  return keyType === "id" ? "number" : "string";
}

function template(className: string, keyType: ModelKeyType): string {
  const table = Str.plural(Str.snake(className));
  const idTs = idType(keyType);

  const importLine =
    keyType === "snowflake"
      ? `import { Model } from "@mahi/database";\nimport { snowflake } from "@mahi/snowflake";`
      : `import { Model } from "@mahi/database";`;

  const configLines: string[] = [`  table: "${table}",`, `  primaryKey: "id",`];

  if (keyType === "uuid") {
    configLines.push(`  keyType: "uuid",`);
  } else if (keyType === "snowflake") {
    configLines.push(`  keyType: snowflake(),`);
  }

  return `${importLine}

/**
 * The ONE type you write: the model's shape. Plain columns are plain
 * types; declare relations with \`BelongsTo<…>\`/\`HasMany<…>\` markers and
 * computed attributes with \`Computed<…>\`. Everything else (the finder
 * return type, the builder, the factory shape) is derived from it.
 */
export interface ${className}Attributes {
  id: ${idTs};
  created_at: import("@mahi/datetime").DateTime;
  updated_at: import("@mahi/datetime").DateTime;
}

export class ${className} extends Model<${className}Attributes>()({
${configLines.join("\n")}
  // \`timestamps\` defaults to true (stamps created_at/updated_at) — set it
  // to \`false\` if this table has no timestamp columns.
  //
  // Add \`casts: { … }\` for boolean/json/datetime columns, and declare
  // relations with a \`static relationships = { … }\` map using the
  // belongsTo()/hasMany()/… helpers.
}) {}
`;
}

function resolveKeyType(options: { uuid?: boolean; snowflake?: boolean }): ModelKeyType {
  if (options.uuid && options.snowflake) {
    throw new Error("make:model: choose only one of --uuid / --snowflake.");
  }

  if (options.uuid) {
    return "uuid";
  }

  if (options.snowflake) {
    return "snowflake";
  }

  return "id";
}

export class MakeModelCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:model <name>";
  description = "Scaffold a new Eloquent-style model class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/models")
      .option("-m, --migration", "Also scaffold a create-table migration")
      .option("-f, --factory", "Also scaffold a model factory")
      .option("--uuid", "Use a client-generated UUID string primary key")
      .option("--snowflake", "Use a client-generated Snowflake string primary key")
      .option("--force", "Overwrite the file if it already exists");
  }

  async handle(
    name: string,
    options: {
      dir: string;
      migration?: boolean;
      factory?: boolean;
      uuid?: boolean;
      snowflake?: boolean;
      force?: boolean;
    },
  ): Promise<void> {
    const keyType = resolveKeyType(options);

    await scaffold({
      name,
      dir: options.dir,
      template: (className) => template(className, keyType),
      filename: () => `${Str.kebab(name)}.model.ts`,
      label: "model",
      force: options.force,
    });

    if (options.migration) {
      const table = Str.plural(Str.snake(name));
      await new MakeMigrationCommand(this.app).handle(`create_${table}_table`, {
        dir: "database/migrations",
        keyType,
        force: options.force,
      });
    }

    if (options.factory) {
      await new MakeFactoryCommand(this.app).handle(name, {
        dir: "database/factories",
        keyType,
        force: options.force,
      });
    }
  }
}
