import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  return `import { Request, rule } from "@mahi/http";

export class ${className} extends Request {
  rules() {
    return {
      // name: rule().string().required(),
    } as const;
  }
}
`;
}

export class MakeRequestCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:request <name>";
  description = "Scaffold a new form Request class with a rules() method.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/http/requests")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Request");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Request",
      template,
      filename: () => `${Str.kebab(className.replace(/Request$/, ""))}.request.ts`,
      label: "request",
      force: options.force,
    });
  }
}
