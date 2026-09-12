import type { Seeder } from "./seeder.js";
import type { AnyModelClass } from "./model.js";
import type { RegisteredMigration } from "./migrator.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Return `Model` subclasses this provider makes serializable inside
     * queued job payloads. Each must declare a `static morphName`. Collected
     * during `DatabaseServiceProvider` boot into the `ModelRegistry` (same
     * pattern as the queue package's `jobs()` hook), so a worker process can
     * rehydrate `{ __model, __id }` references even for models it never
     * imported directly. A flat array of classes — the morph key comes from
     * each model's `morphName`, the lookup from its own `find()`, so no
     * per-model lambdas or key strings are needed.
     */
    models?(): Array<AnyModelClass>;

    /**
     * Return an absolute path to a directory of migration files this
     * provider contributes. Collected by the `migrate`/`migrate:rollback`/
     * `migrate:status` CLI commands alongside the app's own
     * `database/migrations` directory.
     *
     * Prefer `migrationSources()` in a provider that may be bundled: a
     * directory path cannot be resolved inside a single-file executable,
     * and the runner treats an unreadable directory as "no migrations"
     * rather than an error. When a provider implements both, only
     * `migrationSources()` is used.
     */
    migrations?(): string;

    /**
     * Return this provider's migrations as explicit, statically-imported
     * `{ name, migration }` entries — the bundle-safe form of
     * `migrations()`, and the one to reach for when a provider's
     * migrations must survive `bun build --compile`/`esbuild`. Collected
     * by the same `migrate*` commands, and takes precedence over this
     * provider's `migrations()` if both are implemented.
     *
     *     migrationSources() {
     *       return [{ name: "0001_create_jobs_table", migration: createJobsTable }];
     *     }
     *
     * `name` is what lands in the `migrations` table and orders execution
     * — keep it identical to the filename-without-extension the directory
     * form would have produced, or an app that already migrated via
     * `migrations()` will run them a second time.
     */
    migrationSources?(): RegisteredMigration[];

    /**
     * Return Seeder classes this provider contributes. Collected and run,
     * in registration order, by the `db:seed` CLI command.
     */
    seeders?(): Array<new (app: import("@mahiframework/core").Application) => Seeder>;
  }
}
