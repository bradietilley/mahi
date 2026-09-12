import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager, SqliteDriver, DATABASE_TOKEN, SCHEMA_TOKEN } from "@mahiframework/database";
import { Tui } from "@mahiframework/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigrationDir, removeMigrationDir } from "../helpers/migration-fixtures.js";
import { MigrateCommand } from "../../src/commands/migrate.js";

const MIGRATION_A = `
import { Schema } from "@mahiframework/database";

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
import { Schema } from "@mahiframework/database";

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

describe("MigrateCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeMigrationDir("migrate-test");
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

  it("runs every pending migration and prints a DONE status line for each", async () => {
    const { app, driver } = buildApp();
    const fake = Tui.fake([]);

    await new MigrateCommand(app).handle();

    const output = fake.strippedOutput();
    expect(output).toContain("0001_create_widgets");
    expect(output).toContain("0002_create_gadgets");
    expect(output).toContain("DONE");

    const tables = await driver.kysely.introspection.getTables();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["widgets", "gadgets", "migrations"]),
    );
    fake.restore();
  });

  it("colors the DONE status green", async () => {
    const { app } = buildApp();
    const fake = Tui.fake([]);

    await new MigrateCommand(app).handle();

    expect(fake.output()).toContain("\x1b[32m"); // green
    fake.restore();
  });

  it("shows an info message when there's nothing to migrate", async () => {
    const { app } = buildApp();
    const fake = Tui.fake([]);

    await new MigrateCommand(app).handle();
    fake.restore();

    const fakeAgain = Tui.fake([]);
    await new MigrateCommand(app).handle();

    expect(fakeAgain.strippedOutput()).toContain("Nothing to migrate.");
    fakeAgain.restore();
  });

  it("shows FAIL and rethrows when a migration throws", async () => {
    await writeFile(
      path.join(dir, "0003_broken.js"),
      `export default { async up() { throw new Error("boom"); }, async down() {} };`,
    );
    const { app } = buildApp();
    const fake = Tui.fake([]);

    await expect(new MigrateCommand(app).handle()).rejects.toThrow("boom");
    expect(fake.strippedOutput()).toContain("FAIL");
    fake.restore();
  });
});
