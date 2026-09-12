import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";

interface WidgetAttributes {
  id: number;
  name: string;
}

type WidgetTable = WidgetAttributes;

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("chunk / each / lazy / cursor", () => {
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
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    for (let i = 1; i <= 10; i++) {
      await Widget.create({ name: `w${i}` } as WidgetTable);
    }
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("chunk() processes rows in pages", async () => {
    const pageSizes: number[] = [];
    let total = 0;
    await Widget.query()
      .orderBy("id")
      .chunk(3, (rows) => {
        pageSizes.push(rows.length);
        total += rows.length;
      });

    expect(pageSizes).toEqual([3, 3, 3, 1]);
    expect(total).toBe(10);
  });

  it("chunk() yields hydrated model instances", async () => {
    let firstName = "";
    await Widget.query()
      .orderBy("id")
      .chunk(3, (rows) => {
        firstName = rows[0]!.name;

        return false;
      });
    expect(firstName).toBe("w1");
  });

  it("chunk() stops early when the callback returns false", async () => {
    let pages = 0;
    await Widget.query()
      .orderBy("id")
      .chunk(3, () => {
        pages++;

        return false;
      });

    expect(pages).toBe(1);
  });

  it("each() visits every row in order with an index", async () => {
    const seen: Array<[number, string]> = [];
    await Widget.query()
      .orderBy("id")
      .each((row, index) => {
        seen.push([index, row.name]);
      }, 4);

    expect(seen.length).toBe(10);
    expect(seen[0]).toEqual([0, "w1"]);
    expect(seen[9]).toEqual([9, "w10"]);
  });

  it("each() can stop early", async () => {
    const seen: string[] = [];
    await Widget.query()
      .orderBy("id")
      .each((row) => {
        seen.push(row.name);

        if (row.name === "w2") {
          return false;
        }
      }, 5);

    expect(seen).toEqual(["w1", "w2"]);
  });

  it("lazy() yields rows one at a time via for await", async () => {
    const names: string[] = [];

    for await (const row of Widget.query().orderBy("id").lazy(3)) {
      names.push(row.name);
    }

    expect(names).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"]);
  });

  it("cursor() is an alias for lazy()", async () => {
    let count = 0;

    for await (const row of Widget.query().cursor(4)) {
      if (row) {
        count++;
      }
    }

    expect(count).toBe(10);
  });
});
