import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager, SqliteDriver, DATABASE_TOKEN } from "@mahiframework/database";
import { Tui } from "@mahiframework/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbShowCommand } from "../../src/commands/db-show.js";
import { DbTableCommand } from "../../src/commands/db-table.js";

describe("db:show / db:table", () => {
  let app: Application;
  let driver: SqliteDriver;

  beforeEach(async () => {
    app = new Application();
    driver = new SqliteDriver({ filename: ":memory:" });
    const manager = new DatabaseManager(app, { default: "sqlite", connections: { sqlite: {} } });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("note", "text")
      .execute();

    await driver.kysely
      .insertInto("widgets" as never)
      .values({ name: "a" } as never)
      .execute();
    await driver.kysely
      .insertInto("widgets" as never)
      .values({ name: "b" } as never)
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("db:show lists tables with column and row counts", async () => {
    const fake = Tui.fake([]);
    await new DbShowCommand(app).handle();
    const out = fake.strippedOutput();
    fake.restore();

    expect(out).toContain("widgets");
    expect(out).toContain("3"); // 3 columns
    expect(out).toContain("2"); // 2 rows
  });

  it("db:table shows columns of one table", async () => {
    const fake = Tui.fake([]);
    await new DbTableCommand(app).handle("widgets");
    const out = fake.strippedOutput();
    fake.restore();

    expect(out).toContain("id");
    expect(out).toContain("name");
    expect(out).toContain("note");
  });

  it("db:table errors on an unknown table", async () => {
    const fake = Tui.fake([]);
    await new DbTableCommand(app).handle("nope");
    const out = fake.strippedOutput();
    fake.restore();

    expect(out).toContain('Table "nope" not found');
  });
});
