import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../../src/database-manager.js";
import { DATABASE_TOKEN } from "../../src/database-service-provider.js";
import { Model } from "../../src/model.js";
import { simplePaginate } from "../../src/pagination/simple-paginator.js";

interface WidgetAttributes {
  id: string;
  name: string;
  active: number;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("simplePaginate()", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .execute();

    for (let i = 1; i <= 10; i++) {
      const id = String(i).padStart(2, "0");
      await Widget.create({ id, name: `Widget ${id}`, active: i <= 7 ? 1 : 0 });
    }
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("returns the correct slice and hasMore for page 1", async () => {
    const page = await simplePaginate(Widget.query().orderBy("id"), 1, 3);
    expect(page.data.toArray().map((r) => r.id)).toEqual(["01", "02", "03"]);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it("hasMore is false on the last (partial) page", async () => {
    const page = await simplePaginate(Widget.query().orderBy("id"), 4, 3);
    expect(page.data.toArray().map((r) => r.id)).toEqual(["10"]);
    expect(page.hasMore).toBe(false);
  });

  it("hasMore is false exactly at an even page boundary", async () => {
    const page = await simplePaginate(Widget.query().orderBy("id"), 5, 2);
    expect(page.data.toArray()).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("respects where() filters", async () => {
    const page = await simplePaginate(Widget.query().where("active", 1).orderBy("id"), 3, 3);
    // 7 active rows; page 3 (row 7) -> one row, no more
    expect(page.data.toArray().map((r) => r.id)).toEqual(["07"]);
    expect(page.hasMore).toBe(false);
  });

  it("Model.simplePaginate() convenience method works", async () => {
    const page = await Widget.simplePaginate(1, 5);
    expect(page.data.toArray()).toHaveLength(5);
    expect(page.hasMore).toBe(true);
  });
});
