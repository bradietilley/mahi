import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

/**
 * Middleware here is an `HttpPipe` — a `(request, next) => Response`
 * function, not a class — matching how the router and providers'
 * `middleware()` hooks consume them. The stub exports a named pipe the app
 * can register in a provider or on a route.
 */
function template(className: string): string {
  const pipeName = className.charAt(0).toLowerCase() + className.slice(1);

  return `import type { HttpPipe } from "@mahiframework/http";

export const ${pipeName}: HttpPipe = async (request, next) => {
  // Inspect/short-circuit here, or continue down the pipeline:
  return next(request);
};
`;
}

export class MakeMiddlewareCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:middleware <name>";
  description = "Scaffold a new HTTP middleware pipe.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/http/middleware")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Middleware");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Middleware",
      template,
      filename: () => `${Str.kebab(className.replace(/Middleware$/, ""))}.middleware.ts`,
      label: "middleware",
      force: options.force,
    });
  }
}
