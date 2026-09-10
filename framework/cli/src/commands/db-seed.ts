import type { Command as CommanderCommand } from "commander";
import { Tui } from "@mahi/tui";
import { Command } from "../command.js";

export class DbSeedCommand extends Command {
  signature = "db:seed";
  description = "Run every seeder contributed by registered providers.";

  configure(program: CommanderCommand): void {
    program.option("--force", "Run in production without the confirmation prompt", false);
  }

  async handle(options: { force?: boolean } = {}): Promise<void> {
    // Seeders write arbitrary rows, so running one against a production
    // database is a mistake worth one extra keystroke.
    //
    // `migrate:fresh --seed` / `migrate:refresh --seed` call this
    // directly and pass their own `force` through, so the operator
    // confirms once for the whole operation rather than twice.
    if (!(await this.confirmToProceed(options))) {
      return;
    }

    for (const provider of this.app.getProviders()) {
      const seederClasses = provider.seeders?.();

      if (!seederClasses) {
        continue;
      }

      for (const SeederClass of seederClasses) {
        const seeder = new SeederClass(this.app);
        await Tui.task(`Seeding: ${SeederClass.name}`, () => seeder.run());
      }
    }
  }
}
