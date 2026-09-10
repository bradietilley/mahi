import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";

function template(className: string): string {
  return `import type { Application } from "@mahi/core";
import type { AbstractEvent, Listener } from "@mahi/events";

export class ${className} implements Listener {
  constructor(private app: Application) {}

  handle(event: AbstractEvent): void {
    void event;
  }
}
`;
}

export class MakeListenerCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:listener <name>";
  description = "Scaffold a new event Listener class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/listeners")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    await scaffold({
      name,
      dir: options.dir,
      template,
      filename: () => `${Str.kebab(name)}.listener.ts`,
      label: "listener",
      force: options.force,
    });
  }
}
