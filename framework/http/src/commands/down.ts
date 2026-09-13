import { Command } from "@mahiframework/cli";
import type { Command as CommanderCommand } from "commander";
import { Tui } from "@mahiframework/tui";
import { maintenanceMode, type MaintenanceData } from "../maintenance/maintenance-mode.js";

interface DownOptions {
  retry?: string;
  secret?: string;
  message?: string;
  status?: string;
  except?: string[];
}

/**
 * Puts the application into maintenance mode. Every request then gets a
 * 503 (plus `Retry-After` when `--retry` is given) until `maintenance:up`
 * runs, except paths passed via `--except` or requests carrying the
 * `--secret` bypass. Mirrors `php artisan down`, minus its
 * Blade-view-rendering flags, and namespaced rather than bare so that the
 * framework does not reserve `down` as a top-level verb.
 */
export class DownCommand extends Command {
  signature = "maintenance:down";
  description = "Put the application into maintenance mode.";

  configure(program: CommanderCommand): void {
    program
      .option("--retry <seconds>", "Value for the Retry-After header")
      .option(
        "--secret <secret>",
        "Bypass secret (header X-Maintenance-Secret or first path segment)",
      )
      .option("--message <message>", "Message returned in the 503 body")
      .option("--status <code>", "HTTP status to respond with (default 503)")
      .option("--except <path...>", "Path(s) that stay reachable while down");
  }

  async handle(options: DownOptions): Promise<void> {
    const data: MaintenanceData = {};

    if (options.retry !== undefined) {
      data.retryAfter = Number(options.retry);
    }

    if (options.secret !== undefined) {
      data.secret = options.secret;
    }

    if (options.message !== undefined) {
      data.message = options.message;
    }

    if (options.status !== undefined) {
      data.status = Number(options.status);
    }

    if (options.except !== undefined) {
      data.except = options.except;
    }

    await maintenanceMode(this.app).activate(data);
    Tui.warning("Application is now in maintenance mode.");

    if (data.secret) {
      Tui.info(`Bypass secret: ${data.secret}`);
    }
  }
}
