import { Application, ServiceProvider } from "@mahiframework/core";
import type { RegisteredMigration } from "@mahiframework/database";
import { describe, expect, it } from "vitest";
import { collectMigrationSources } from "../../src/commands/migration-directories.js";

function migration(name: string): RegisteredMigration {
  return {
    name,
    migration: {
      async up() {},
      async down() {},
    },
  };
}

/**
 * `toEqual` compares the `migration` object's `up`/`down` by reference,
 * and every `migration()` call above builds fresh closures — so entries
 * are compared by the only part that is actually meaningful here: the
 * name (for registered entries) or the path itself (for directories).
 */
function names(sources: ReturnType<typeof collectMigrationSources>): string[] {
  return sources.map((source) => (typeof source === "string" ? source : source.name));
}

class DirectoryProvider extends ServiceProvider {
  migrations(): string {
    return "/packages/legacy/migrations";
  }
}

class StaticProvider extends ServiceProvider {
  migrationSources(): RegisteredMigration[] {
    return [migration("0001_create_jobs_table")];
  }
}

/**
 * A provider part-way through the move: it advertises both forms. Only
 * the static one should be collected, or the same migration is offered
 * twice under (potentially) two different names.
 */
class BothProvider extends ServiceProvider {
  migrations(): string {
    return "/packages/both/migrations";
  }

  migrationSources(): RegisteredMigration[] {
    return [migration("0001_create_notifications_table")];
  }
}

async function appWith(...providers: Array<new (app: Application) => ServiceProvider>) {
  const app = new Application();

  for (const provider of providers) {
    app.register(provider);
  }

  await app.bootstrap();

  return app;
}

describe("collectMigrationSources", () => {
  it("defaults the app's own migrations to the conventional directory", async () => {
    const app = await appWith();

    expect(collectMigrationSources(app)).toEqual(["database/migrations"]);
  });

  it("honours database.migrationsPath for the app's own migrations", async () => {
    const app = await appWith();
    app.config.set("database", { migrationsPath: "/srv/app/database/migrations" });

    expect(collectMigrationSources(app)).toEqual(["/srv/app/database/migrations"]);
  });

  /**
   * The compiled-binary path: an app with a static registry never wants
   * its `migrationsPath` collected as well, because that directory does
   * not exist inside the bundle and would silently contribute nothing —
   * or, worse, exist beside the binary and contribute something stale.
   */
  it("uses database.migrationSources instead of the path when the app sets one", async () => {
    const app = await appWith();
    const registry = [migration("0001_create_sessions_table")];
    app.config.set("database", {
      migrationsPath: "database/migrations",
      migrationSources: registry,
    });

    expect(collectMigrationSources(app)).toEqual(registry);
  });

  it("falls back to the path when database.migrationSources is empty", async () => {
    const app = await appWith();
    app.config.set("database", { migrationsPath: "database/migrations", migrationSources: [] });

    expect(collectMigrationSources(app)).toEqual(["database/migrations"]);
  });

  it("collects a provider's migrations() directory", async () => {
    const app = await appWith(DirectoryProvider);

    expect(collectMigrationSources(app)).toEqual([
      "database/migrations",
      "/packages/legacy/migrations",
    ]);
  });

  it("collects a provider's migrationSources() entries", async () => {
    const app = await appWith(StaticProvider);

    expect(names(collectMigrationSources(app))).toEqual([
      "database/migrations",
      "0001_create_jobs_table",
    ]);
  });

  it("prefers migrationSources() over migrations() when a provider has both", async () => {
    const app = await appWith(BothProvider);

    expect(names(collectMigrationSources(app))).toEqual([
      "database/migrations",
      "0001_create_notifications_table",
    ]);
  });

  it("preserves provider registration order", async () => {
    const app = await appWith(DirectoryProvider, StaticProvider);

    expect(names(collectMigrationSources(app))).toEqual([
      "database/migrations",
      "/packages/legacy/migrations",
      "0001_create_jobs_table",
    ]);
  });
});
