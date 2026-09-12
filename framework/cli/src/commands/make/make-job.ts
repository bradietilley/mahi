import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";

function template(className: string): string {
  return `import { app } from "@mahiframework/core";
import { Job } from "@mahiframework/queue";

export class ${className} extends Job {
  constructor() {
    super();
  }

  handle(): void {
    app().logger.info("${className} ran");
  }
}
`;
}

export class MakeJobCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:job <name>";
  description = "Scaffold a new queued Job class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/jobs")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Job",
      template,
      filename: () => `${Str.kebab(name)}.job.ts`,
      label: "job",
      force: options.force,
    });
  }
}
