import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../../src/database-manager.js";
import { DATABASE_TOKEN } from "../../src/database-service-provider.js";
import { Model } from "../../src/model.js";
import { paginate } from "../../src/pagination/length-aware-paginator.js";

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

describe("paginate() (length-aware)", () => {
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

    // 10 rows, ids "01".."10" so string ordering matches numeric ordering.
    for (let i = 1; i <= 10; i++) {
      const id = String(i).padStart(2, "0");
      await Widget.create({ id, name: `Widget ${id}`, active: i <= 7 ? 1 : 0 });
    }
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("returns the correct slice for page 1", async () => {
    const page = await paginate(Widget.query().orderBy("id"), 1, 3);
    expect(page.data.toArray().map((r) => r.id)).toEqual(["01", "02", "03"]);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(3);
    expect(page.total).toBe(10);
    expect(page.totalPages).toBe(4);
    expect(page.hasMore).toBe(true);
  });

  it("returns the correct slice for a middle page", async () => {
    const page = await paginate(Widget.query().orderBy("id"), 2, 3);
    expect(page.data.toArray().map((r) => r.id)).toEqual(["04", "05", "06"]);
    expect(page.hasMore).toBe(true);
  });

  it("returns the correct (partial) slice for the last page, with hasMore false", async () => {
    const page = await paginate(Widget.query().orderBy("id"), 4, 3);
    expect(page.data.toArray().map((r) => r.id)).toEqual(["10"]);
    expect(page.hasMore).toBe(false);
  });

  it("hasMore is false exactly at a page count that's an even multiple of perPage", async () => {
    const page = await paginate(Widget.query().orderBy("id"), 5, 2); // 10 rows / 2 per page = 5 pages exactly
    expect(page.data.toArray()).toHaveLength(2);
    expect(page.totalPages).toBe(5);
    expect(page.hasMore).toBe(false);
  });

  it("total/totalPages reflect where() filters, not the whole table", async () => {
    const page = await paginate(Widget.query().where("active", 1).orderBy("id"), 1, 3);
    expect(page.total).toBe(7);
    expect(page.totalPages).toBe(3);
    expect(page.data.toArray()).toHaveLength(3);
  });

  it("Model.paginate() convenience method matches paginate(Model.query(), ...)", async () => {
    const page = await Widget.paginate(1, 5);
    expect(page.data.toArray()).toHaveLength(5);
    expect(page.total).toBe(10);
  });
});
