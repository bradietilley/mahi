import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahiframework/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  return `import { Mailable, Envelope, Content } from "@mahiframework/mail";

export class ${className} extends Mailable {
  override envelope(): Envelope {
    return new Envelope({ subject: "${className}" });
  }

  override content(): Content {
    return new Content({ text: () => "" });
  }
}
`;
}

export class MakeMailCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:mail <name>";
  description = "Scaffold a new Mailable class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/mail")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Mail");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Mail",
      template,
      filename: () => `${Str.kebab(className.replace(/Mail$/, ""))}.mail.ts`,
      label: "mail",
      force: options.force,
    });
  }
}
