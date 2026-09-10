import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";

function template(className: string): string {
  return `import { AbstractEvent } from "@mahi/events";

export class ${className} extends AbstractEvent {
  constructor() {
    super();
  }
}
`;
}

export class MakeEventCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:event <name>";
  description = "Scaffold a new Event class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/events")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    await scaffold({
      name,
      dir: options.dir,
      template,
      filename: () => `${Str.kebab(name)}.event.ts`,
      label: "event",
      force: options.force,
    });
  }
}
