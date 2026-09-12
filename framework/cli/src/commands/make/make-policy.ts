import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  return `import { Policy } from "@mahiframework/authorization";

export class ${className} extends Policy {
  view(): boolean {
    return true;
  }
}
`;
}

export class MakePolicyCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:policy <name>";
  description = "Scaffold a new authorization Policy class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/policies")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Policy");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Policy",
      template,
      filename: () => `${Str.kebab(className.replace(/Policy$/, ""))}.policy.ts`,
      label: "policy",
      force: options.force,
    });
  }
}
