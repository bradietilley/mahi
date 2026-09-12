import { Command } from "@mahiframework/cli";
import { Tui } from "@mahiframework/tui";
import { maintenanceMode } from "../maintenance/maintenance-mode.js";

/**
 * Brings the application out of maintenance mode. Mirrors `php artisan up`,
 * namespaced rather than bare so that the framework does not reserve `up` as
 * a top-level verb.
 */
export class UpCommand extends Command {
  signature = "maintenance:up";
  description = "Bring the application out of maintenance mode.";

  async handle(): Promise<void> {
    const mode = maintenanceMode(this.app);

    if (!(await mode.active())) {
      Tui.info("Application is already up.");

      return;
    }

    await mode.deactivate();
    Tui.success("Application is now live.");
  }
}
