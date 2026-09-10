import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { DatabaseManager, SqliteDriver, DATABASE_TOKEN, SCHEMA_TOKEN } from "@mahi/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigrationDir, removeMigrationDir } from "../helpers/migration-fixtures.js";
import { MigrateRefreshCommand } from "../../src/commands/migrate-refresh.js";

const MIGRATION_A = `
import { Schema } from "@mahi/database";

export default {
  async up() {
    await Schema.create("widgets", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    await Schema.drop("widgets");
  },
};
`;

const MIGRATION_B = `
import { Schema } from "@mahi/database";

export default {
  async up() {
    await Schema.create("gadgets", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    await Schema.drop("gadgets");
  },
};
`;

describe("MigrateRefreshCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeMigrationDir("migrate-refresh-test");
    await writeFile(path.join(dir, "0001_create_widgets.js"), MIGRATION_A);
    await writeFile(path.join(dir, "0002_create_gadgets.js"), MIGRATION_B);
  });

  afterEach(async () => {
    clearCurrentApp();
    await removeMigrationDir(dir);
  });

  function buildApp(): { app: Application; driver: SqliteDriver } {
    const app = new Application();
    app.config.set("database", { migrationsPath: dir });

    const driver = new SqliteDriver({ filename: ":memory:" });
    const manager = new DatabaseManager(app, { default: "sqlite", connections: { sqlite: {} } });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    app.bind(SCHEMA_TOKEN, () => manager.schema());
    setCurrentApp(app);

    return { app, driver };
  }

  it("rolls back every batch (calling down()) then re-runs every migration", async () => {
    const { app, driver } = buildApp();
    const command = new MigrateRefreshCommand(app);

    // Seed two separate batches first, so refresh must loop rollback().
    await writeFile(path.join(dir, "0001_create_widgets.js"), MIGRATION_A);
    const { MigrationRunner } = await import("@mahi/database");
    const runner = new MigrationRunner(driver.kysely);
    await runner.up([dir]);
    await writeFile(path.join(dir, "0002_create_gadgets.js"), MIGRATION_B);
    await runner.up([dir]);

    await command.handle({ seed: false });

    const tables = await driver.kysely.introspection.getTables();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["widgets", "gadgets", "migrations"]),
    );

    const status = await runner.status([dir]);
    expect(status).toEqual([
      { name: "0001_create_widgets", ran: true, batch: 1 },
      { name: "0002_create_gadgets", ran: true, batch: 1 },
    ]);
  });

  it("works fine when nothing has migrated yet", async () => {
    const { app, driver } = buildApp();
    const command = new MigrateRefreshCommand(app);

    await command.handle({ seed: false });

    const tables = await driver.kysely.introspection.getTables();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["widgets", "gadgets", "migrations"]),
    );
  });

  it("runs seeders when --seed is passed", async () => {
    const { app } = buildApp();

    const seeded: string[] = [];
    class FakeSeeder {
      constructor(_app: Application) {}
      async run(): Promise<void> {
        seeded.push("ran");
      }
    }

    const provider = { seeders: () => [FakeSeeder as any] } as any;
    app.getProviders = () => [provider];

    const command = new MigrateRefreshCommand(app);
    await command.handle({ seed: true });

    expect(seeded).toEqual(["ran"]);
  });

  it("does not run seeders when --seed is not passed", async () => {
    const { app } = buildApp();

    const seeded: string[] = [];
    class FakeSeeder {
      constructor(_app: Application) {}
      async run(): Promise<void> {
        seeded.push("ran");
      }
    }

    const provider = { seeders: () => [FakeSeeder as any] } as any;
    app.getProviders = () => [provider];

    const command = new MigrateRefreshCommand(app);
    await command.handle({ seed: false });

    expect(seeded).toEqual([]);
  });
});
