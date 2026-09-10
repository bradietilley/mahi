import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

/**
 * A console command name defaults to the kebab-cased class name minus the
 * `Command` suffix (`SendEmailsCommand` → `send-emails`), which the author
 * usually namespaces (`app:send-emails`) before registering it in a
 * provider's `commands()` hook.
 */
function template(className: string): string {
  const signature = Str.kebab(className.replace(/Command$/, ""));

  return `import { Command } from "@mahi/cli";

export class ${className} extends Command {
  signature = "${signature}";
  description = "Description of the ${signature} command.";

  async handle(): Promise<void> {
    this.info("${className} ran.");
  }
}
`;
}

export class MakeCommandCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:command <name>";
  description = "Scaffold a new console Command class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/commands")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Command");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Command",
      template,
      filename: () => `${Str.kebab(className.replace(/Command$/, ""))}.command.ts`,
      label: "command",
      force: options.force,
    });
  }
}
