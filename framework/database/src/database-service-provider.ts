import { ServiceProvider, isConnectable, setAfterCommitResolver, DATABASE_TOKEN } from "@mahi/core";
import { DatabaseManager, type DatabaseConfig } from "./database-manager.js";
import type { DatabaseDriver } from "./drivers/driver.js";
import { SqliteDriver } from "./drivers/sqlite-driver.js";
import { MysqlDriver } from "./drivers/mysql-driver.js";
import { PostgresDriver } from "./drivers/postgres-driver.js";
import { registerValidationPresenceResolver } from "./validation-presence.js";
import { ModelRegistry } from "./model-registry.js";
import { afterCommit, inTransaction } from "./transaction-context.js";

/**
 * Built-in driver factories, keyed by driver *type* (`connection.driver`).
 * A plugin adds a new engine by registering another factory the same way —
 * see `BUILTIN_DRIVERS` usage in `register()`.
 */
type DriverFactory = (config: Record<string, any>) => DatabaseDriver;

const BUILTIN_DRIVERS: Record<string, DriverFactory> = {
  sqlite: (config) => new SqliteDriver(config as any),
  mysql: (config) => new MysqlDriver(config as any),
  mariadb: (config) => new MysqlDriver(config as any),
  postgres: (config) => new PostgresDriver(config as any),
  pgsql: (config) => new PostgresDriver(config as any),
};

// `DATABASE_TOKEN`'s canonical definition lives in `@mahi/core`'s
// `well-known-tokens` (resolved cross-package by CLI migration commands
// and the queue's database driver); re-exported so this package's public
// API is unchanged. `SCHEMA_TOKEN`/`MODEL_REGISTRY_TOKEN` are
// package-private and stay local.
export { DATABASE_TOKEN };
export const SCHEMA_TOKEN = "db.schema";
export const MODEL_REGISTRY_TOKEN = "db.models";

/**
 * Registers the DatabaseManager singleton with the built-in "sqlite"
 * driver pre-registered via `extend()` (same mechanism a plugin would use
 * to add e.g. a "postgres" driver later — no special-casing).
 *
 * On boot, connects the resolved default driver if it implements
 * `Connectable` (sqlite's better-sqlite3 driver does not, since it's fully
 * synchronous — this matters for future async drivers).
 *
 * On shutdown, disconnects every connection that was actually resolved —
 * see `shutdown()`. Without that, a process using MySQL or Postgres never
 * exits: a live pool keeps Node's event loop alive whether or not anyone
 * is still querying it.
 */
export class DatabaseServiceProvider extends ServiceProvider {
  private modelRegistry = new ModelRegistry();

  register(): void {
    // Wire the cross-package after-commit seam (see `@mahi/core`'s
    // `deferral.ts`): producers below this package in the dependency graph
    // (`@mahi/events`, `@mahi/mail`, `@mahi/broadcasting`) can't import our
    // `afterCommit()` directly without a cycle, so they call core's, which
    // we back here with the real transaction-aware implementation. Done in
    // `register()` (not `boot()`) so deferral works from the moment
    // providers start running.
    setAfterCommitResolver({
      run: (callback) => afterCommit(callback),
      active: () => inTransaction(),
    });

    this.app.singleton(MODEL_REGISTRY_TOKEN, () => this.modelRegistry);

    this.app.singleton(DATABASE_TOKEN, (app) => {
      const config = app.config.require<DatabaseConfig>("database");
      const manager = new DatabaseManager(app, config);

      // Register one factory per configured connection, dispatching on the
      // connection's `driver` type (falling back to its name). This is how
      // a plugin would add a "clickhouse" connection too — nothing here is
      // special-cased to the built-ins beyond the `BUILTIN_DRIVERS` table.
      for (const name of manager.connectionNames()) {
        manager.extend(name, () => {
          const type = manager.driverType(name);
          const factory = BUILTIN_DRIVERS[type];

          if (!factory) {
            throw new Error(
              `Unsupported database driver "${type}" for connection "${name}". ` +
                `Known drivers: ${Object.keys(BUILTIN_DRIVERS).join(", ")}.`,
            );
          }

          return factory(manager.connectionConfig(name) as Record<string, any>);
        });
      }

      return manager;
    });

    this.app.bind(SCHEMA_TOKEN, (app) => {
      return app.make<DatabaseManager>(DATABASE_TOKEN).schema();
    });
  }

  async boot(): Promise<void> {
    for (const provider of this.app.getProviders()) {
      const models = provider.models?.();

      if (!models) {
        continue;
      }

      for (const modelClass of models) {
        this.modelRegistry.register(modelClass);
      }
    }

    const manager = this.app.make<DatabaseManager>(DATABASE_TOKEN);
    const driver = manager.driver();

    if (isConnectable(driver)) {
      await driver.connect();
    }

    registerValidationPresenceResolver();
  }

  /**
   * Drain every connection this app actually opened.
   *
   * Goes through the manager's resolved drivers rather than the
   * *configured* connection list, so a named connection nothing ever
   * touched is not constructed here purely to be torn down (constructing
   * a MySQL driver builds a pool — resolving it during shutdown would
   * open connections while trying to close them).
   *
   * Skipped entirely when `DATABASE_TOKEN` was never resolved (a boot
   * that threw before this provider's own `boot()` ran): `make()`ing the
   * manager here would construct the thing we are trying not to leave
   * open.
   */
  async shutdown(): Promise<void> {
    if (!this.app.isResolved(DATABASE_TOKEN)) {
      return;
    }

    const manager = this.app.make<DatabaseManager>(DATABASE_TOKEN);

    for (const error of await manager.disconnectAll()) {
      this.app.logger.error("database: failed to disconnect a connection during shutdown.", {
        error,
      });
    }
  }
}
