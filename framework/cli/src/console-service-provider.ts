import { readFileSync } from "node:fs";
import { ServiceProvider, base_path } from "@mahiframework/core";
import { ConsoleKernel, type ConsoleKernelOptions } from "./console-kernel.js";
import { MigrateCommand } from "./commands/migrate.js";
import { MigrateRollbackCommand } from "./commands/migrate-rollback.js";
import { MigrateStatusCommand } from "./commands/migrate-status.js";
import { MigrateFreshCommand } from "./commands/migrate-fresh.js";
import { MigrateRefreshCommand } from "./commands/migrate-refresh.js";
import { MigrateResetCommand } from "./commands/migrate-reset.js";
import { DbSeedCommand } from "./commands/db-seed.js";
import { DbWipeCommand } from "./commands/db-wipe.js";
import { DbShowCommand } from "./commands/db-show.js";
import { DbTableCommand } from "./commands/db-table.js";
import { MakeMigrationCommand } from "./commands/make-migration.js";
import { MakeProviderCommand } from "./commands/make-provider.js";
import { MakeModelCommand } from "./commands/make/make-model.js";
import { MakeEventCommand } from "./commands/make/make-event.js";
import { MakeListenerCommand } from "./commands/make/make-listener.js";
import { MakeJobCommand } from "./commands/make/make-job.js";
import { MakeSeederCommand } from "./commands/make/make-seeder.js";
import { MakeFactoryCommand } from "./commands/make/make-factory.js";
import { MakePolicyCommand } from "./commands/make/make-policy.js";
import { MakeResourceCommand } from "./commands/make/make-resource.js";
import { MakeRequestCommand } from "./commands/make/make-request.js";
import { MakeControllerCommand } from "./commands/make/make-controller.js";
import { MakeMiddlewareCommand } from "./commands/make/make-middleware.js";
import { MakeCommandCommand } from "./commands/make/make-command.js";
import { MakeNotificationCommand } from "./commands/make/make-notification.js";
import { MakeMailCommand } from "./commands/make/make-mail.js";
import { MakeTestCommand } from "./commands/make/make-test.js";
import { TestCommand } from "./commands/test.js";

export const CONSOLE_KERNEL_TOKEN = "console.kernel";

const BUILT_IN_COMMANDS = [
  MigrateCommand,
  MigrateRollbackCommand,
  MigrateStatusCommand,
  MigrateFreshCommand,
  MigrateRefreshCommand,
  MigrateResetCommand,
  DbSeedCommand,
  DbWipeCommand,
  DbShowCommand,
  DbTableCommand,
  MakeMigrationCommand,
  MakeProviderCommand,
  MakeModelCommand,
  MakeEventCommand,
  MakeListenerCommand,
  MakeJobCommand,
  MakeSeederCommand,
  MakeFactoryCommand,
  MakePolicyCommand,
  MakeResourceCommand,
  MakeRequestCommand,
  MakeControllerCommand,
  MakeMiddlewareCommand,
  MakeCommandCommand,
  MakeNotificationCommand,
  MakeMailCommand,
  MakeTestCommand,
  TestCommand,
];

/**
 * Registers the ConsoleKernel singleton with every built-in command
 * pre-registered. `bin/console.ts` resolves the kernel and calls
 * `collectFromProviders()` + `run()` after `app.bootstrap()` completes.
 *
 * An app that ships as a named executable should subclass this and override
 * `kernelOptions()` to declare that name, rather than letting it be derived
 * from `argv[1]`:
 *
 *     class MyConsoleServiceProvider extends ConsoleServiceProvider {
 *       protected override kernelOptions() {
 *         return { name: "myapp", description: "My app" };
 *       }
 *     }
 */
export class ConsoleServiceProvider extends ServiceProvider {
  /**
   * Options for the kernel. Empty by default, which derives the program name
   * from `argv[1]` and detects the runtime mode, correct for a compiled
   * binary and for `npx <app>`, and wrong only for an app invoked through a
   * wrapper script named differently from its entry point.
   */
  protected kernelOptions(): ConsoleKernelOptions {
    return {};
  }

  /**
   * The version `--version` reports. Defaults to the `version` field of the
   * application's own `package.json`, so `./artisan --version` works in every
   * scaffolded app without configuration. Returns `undefined` (flag stays
   * off) if that file cannot be read or has no version, and an explicit
   * `version` in `kernelOptions()` always wins.
   */
  protected resolveVersion(): string | undefined {
    try {
      const pkg = JSON.parse(readFileSync(base_path("package.json"), "utf8")) as {
        version?: unknown;
      };

      return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  }

  register(): void {
    this.app.singleton(CONSOLE_KERNEL_TOKEN, (app) => {
      const options = this.kernelOptions();
      const kernel = new ConsoleKernel(app, {
        ...options,
        version: options.version ?? this.resolveVersion(),
      });

      for (const CommandClass of BUILT_IN_COMMANDS) {
        kernel.addCommand(CommandClass);
      }

      return kernel;
    });
  }
}
