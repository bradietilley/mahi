import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../command.js";
import { scaffold, toClassName } from "./make/scaffold.js";

function template(className: string): string {
  return `import { ServiceProvider } from "@mahiframework/core";

export class ${className} extends ServiceProvider {
  register(): void {
    // this.app.singleton("token", (app) => new Something());
  }

  boot(): void {
    // runs after every provider's register() has completed
  }
}
`;
}

export class MakeProviderCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:provider <name>";
  description = "Scaffold a new ServiceProvider class.";

  configure(program: CommanderCommand): void {
    // `src/providers` (kebab file in a subdir), matching every other
    // generator and the template's own `src/providers/app.provider.ts`.
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/providers")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Provider");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Provider",
      template,
      filename: () => `${Str.kebab(className.replace(/Provider$/, ""))}.provider.ts`,
      label: "provider",
      force: options.force,
    });
  }
}
