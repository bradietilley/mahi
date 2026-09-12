import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";

function template(className: string): string {
  return `import { Seeder } from "@mahiframework/database";

export class ${className} extends Seeder {
  async run(): Promise<void> {
    // await new SomeFactory().times(10).create();
  }
}
`;
}

export class MakeSeederCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:seeder <name>";
  description = "Scaffold a new database Seeder class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "database/seeders")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Seeder",
      template,
      filename: () => `${Str.kebab(name)}.ts`,
      label: "seeder",
      force: options.force,
    });
  }
}
