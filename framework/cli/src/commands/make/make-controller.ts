import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  return `import { Controller, HttpResponse, type Request, type ResponseInput } from "@mahiframework/http";

export class ${className} extends Controller {
  async handle(request: Request): Promise<ResponseInput> {
    void request;
    return HttpResponse.json({});
  }
}
`;
}

export class MakeControllerCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:controller <name>";
  description = "Scaffold a new HTTP Controller class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/http/controllers")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Controller");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Controller",
      template,
      filename: () => `${Str.kebab(className.replace(/Controller$/, ""))}.controller.ts`,
      label: "controller",
      force: options.force,
    });
  }
}
