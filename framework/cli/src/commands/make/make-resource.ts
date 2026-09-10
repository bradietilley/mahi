import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  const base = className.replace(/Resource$/, "");
  const jsonType = `${base}Json`;

  return `import { Resource } from "@mahi/http";

export interface ${jsonType} {
  id: string;
}

export class ${className} extends Resource<{ id: string }, ${jsonType}> {
  toJson(): ${jsonType} {
    return {
      id: this.model.id,
    };
  }
}
`;
}

export class MakeResourceCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:resource <name>";
  description = "Scaffold a new API Resource class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/http/resources")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Resource");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Resource",
      template,
      filename: () => `${Str.kebab(className.replace(/Resource$/, ""))}.resource.ts`,
      label: "resource",
      force: options.force,
    });
  }
}
