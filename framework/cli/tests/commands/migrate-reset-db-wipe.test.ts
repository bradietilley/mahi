import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DatabaseManager,
  MigrationRunner,
  SqliteDriver,
  DATABASE_TOKEN,
  SCHEMA_TOKEN,
} from "@mahiframework/database";
import { Tui } from "@mahiframework/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigrationDir, removeMigrationDir } from "../helpers/migration-fixtures.js";
import { MigrateResetCommand } from "../../src/commands/migrate-reset.js";
import { DbWipeCommand } from "../../src/commands/db-wipe.js";

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

/** A migration whose down() throws. Reset must surface this, wipe must not care. */
const MIGRATION_BAD_DOWN = `
import { Schema } from "@mahiframework/database";

export default {
  async up() {
    await Schema.create("broken", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    throw new Error("down() is broken");
  },
};
`;

describe("MigrateResetCommand / DbWipeCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeMigrationDir("migrate-reset-test");
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

  const tableNames = async (driver: SqliteDriver) =>
    (await driver.kysely.introspection.getTables()).map((t) => t.name);

  describe("migrate:reset", () => {
    it("rolls back every batch, not just the most recent", async () => {
      const { app, driver } = buildApp();
      // Two separate runs, so two separate batches, the thing that
      // distinguishes reset from rollback.
      await new MigrationRunner(driver.kysely).up([dir]);

      const fake = Tui.fake([]);
      await new MigrateResetCommand(app).handle({ force: true });

      const output = fake.strippedOutput();
      expect(output).toContain("0001_create_widgets");
      expect(output).toContain("0002_create_gadgets");

      const tables = await tableNames(driver);
      expect(tables).not.toContain("widgets");
      expect(tables).not.toContain("gadgets");
      fake.restore();
    });

    it("keeps the migrations table, so history survives", async () => {
      // The difference from db:wipe. reset() empties the schema via
      // down(), but the ledger itself remains. The migrations are simply
      // marked un-run.
      const { app, driver } = buildApp();
      await new MigrationRunner(driver.kysely).up([dir]);

      const fake = Tui.fake([]);
      await new MigrateResetCommand(app).handle({ force: true });
      fake.restore();

      expect(await tableNames(driver)).toContain("migrations");
    });

    it("--pretend lists migrations without running them", async () => {
      const { app, driver } = buildApp();
      await new MigrationRunner(driver.kysely).up([dir]);

      const fake = Tui.fake([]);
      await new MigrateResetCommand(app).handle({ pretend: true });

      expect(fake.strippedOutput()).toContain("would roll back");
      // Still there, pretend changed nothing.
      expect(await tableNames(driver)).toContain("widgets");
      fake.restore();
    });

    it("reports when there is nothing to reset", async () => {
      const { app } = buildApp();

      const fake = Tui.fake([]);
      await new MigrateResetCommand(app).handle({ force: true });

      expect(fake.strippedOutput()).toContain("Nothing to reset.");
      fake.restore();
    });

    it("surfaces a broken down(), where db:wipe would not", async () => {
      // The reason both commands exist. reset() runs each down(), so a
      // broken one fails loudly. Which is the value, since a down()
      // nobody runs is a down() nobody knows is broken.
      await writeFile(path.join(dir, "0003_broken.js"), MIGRATION_BAD_DOWN);
      const { app, driver } = buildApp();
      await new MigrationRunner(driver.kysely).up([dir]);

      const fake = Tui.fake([]);
      await expect(new MigrateResetCommand(app).handle({ force: true })).rejects.toThrow(
        /down\(\) is broken/,
      );
      fake.restore();

      expect(await tableNames(driver)).toContain("broken");
    });
  });

  describe("db:wipe", () => {
    it("drops every table including the migrations ledger", async () => {
      const { app, driver } = buildApp();
      await new MigrationRunner(driver.kysely).up([dir]);

      expect(await tableNames(driver)).toContain("migrations");

      const fake = Tui.fake([]);
      await new DbWipeCommand(app).handle({ force: true });

      expect(fake.strippedOutput()).toContain("Database wiped.");
      fake.restore();

      // Nothing left at all, no schema, and no record anything ever ran.
      expect(await tableNames(driver)).toEqual([]);
    });

    it("ignores a broken down(), since it never calls one", async () => {
      // The complement of the reset test above: wipe drops tables
      // directly, so a migration cannot object to being removed.
      await writeFile(path.join(dir, "0003_broken.js"), MIGRATION_BAD_DOWN);
      const { app, driver } = buildApp();
      await new MigrationRunner(driver.kysely).up([dir]);

      const fake = Tui.fake([]);
      await new DbWipeCommand(app).handle({ force: true });
      fake.restore();

      expect(await tableNames(driver)).toEqual([]);
    });

    it("succeeds on an already-empty database", async () => {
      const { app, driver } = buildApp();

      const fake = Tui.fake([]);
      await new DbWipeCommand(app).handle({ force: true });
      fake.restore();

      expect(await tableNames(driver)).toEqual([]);
    });
  });
});
