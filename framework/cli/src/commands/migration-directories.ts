import type { Application } from "@mahiframework/core";
import type { MigrationSource, RegisteredMigration } from "@mahiframework/database";

/**
 * Gathers every migration source in play, in the order the runner should
 * consider them:
 *
 *   1. the app's own migrations — either a static list under
 *      `database.migrationSources` (set by an app that intends to be
 *      bundled; see `MigrationSource`) or the `database.migrationsPath`
 *      directory, which defaults to `"database/migrations"` relative to
 *      `base_path()`;
 *   2. every provider's contributed migrations, via its
 *      `migrationSources()` hook if it has one, else its `migrations()`
 *      directory.
 *
 * The static forms exist for the compiled-binary case: a directory path
 * resolves to nothing inside a single-file executable, and the runner
 * treats an unreadable directory as "nothing to discover" rather than an
 * error — so a bundled app silently migrates zero tables and then runs
 * against an empty database. Both forms are accepted here and may be
 * mixed; the runner deduplicates by name.
 */
export function collectMigrationSources(app: Application): MigrationSource[] {
  const sources: MigrationSource[] = [];

  const appSources = app.config.get<RegisteredMigration[] | undefined>(
    "database.migrationSources",
    undefined,
  );

  if (appSources && appSources.length > 0) {
    sources.push(...appSources);
  } else {
    sources.push(app.config.get<string>("database.migrationsPath", "database/migrations"));
  }

  for (const provider of app.getProviders()) {
    const registered = provider.migrationSources?.();

    if (registered && registered.length > 0) {
      sources.push(...registered);
      continue;
    }

    const dir = provider.migrations?.();

    if (dir) {
      sources.push(dir);
    }
  }

  return sources;
}
