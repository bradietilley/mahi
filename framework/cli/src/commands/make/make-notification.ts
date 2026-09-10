import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold, toClassName } from "./scaffold.js";

function template(className: string): string {
  return `import { Notification, type NotificationRoutable } from "@mahi/notifications";

export class ${className} extends Notification {
  via(notifiable: NotificationRoutable): string[] {
    void notifiable;
    return ["mail"];
  }

  // toMail(notifiable: NotificationRoutable): Mailable { ... }
  // toDatabase(notifiable: NotificationRoutable): object { return {}; }
}
`;
}

export class MakeNotificationCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:notification <name>";
  description = "Scaffold a new Notification class.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "src/notifications")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    const className = toClassName(name, "Notification");
    await scaffold({
      name,
      dir: options.dir,
      suffix: "Notification",
      template,
      filename: () => `${Str.kebab(className.replace(/Notification$/, ""))}.notification.ts`,
      label: "notification",
      force: options.force,
    });
  }
}
