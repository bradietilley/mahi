import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import {
  DatabaseManager,
  MigrationRunner,
  SqliteDriver,
  DATABASE_TOKEN,
  SCHEMA_TOKEN,
} from "@mahi/database";
import { Tui } from "@mahi/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigrationDir, removeMigrationDir } from "../helpers/migration-fixtures.js";
import { MigrateRollbackCommand } from "../../src/commands/migrate-rollback.js";

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

describe("MigrateRollbackCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeMigrationDir("migrate-rollback-test");
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

  it("rolls back the most recent batch and prints a DONE status line for each", async () => {
    const { app, driver } = buildApp();
    await new MigrationRunner(driver.kysely).up([dir]);

    const fake = Tui.fake([]);
    await new MigrateRollbackCommand(app).handle();

    const output = fake.strippedOutput();
    expect(output).toContain("0001_create_widgets");
    expect(output).toContain("0002_create_gadgets");
    expect(output).toContain("DONE");

    const tables = await driver.kysely.introspection.getTables();
    expect(tables.map((t) => t.name)).not.toContain("widgets");
    expect(tables.map((t) => t.name)).not.toContain("gadgets");
    fake.restore();
  });

  it("shows an info message when there's nothing to roll back", async () => {
    const { app } = buildApp();

    const fake = Tui.fake([]);
    await new MigrateRollbackCommand(app).handle();

    expect(fake.strippedOutput()).toContain("Nothing to roll back.");
    fake.restore();
  });
});
