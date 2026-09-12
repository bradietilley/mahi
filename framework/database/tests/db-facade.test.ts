import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { DB } from "../src/db-facade.js";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";

interface WidgetTable {
  id: string;
  name: string;
  price: number;
}

async function createWidgetsTable(kysely: Kysely<any>): Promise<void> {
  await kysely.schema
    .createTable("widgets")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("price", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

describe("DB.table() / DB.query()", () => {
  let manager: DatabaseManager;
  let kysely: Kysely<any>;

  beforeEach(async () => {
    const app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    kysely = manager.connection().kysely;
    await createWidgetsTable(kysely);
    await kysely
      .insertInto("widgets")
      .values([
        { id: "1", name: "Sprocket", price: 10 },
        { id: "2", name: "Cog", price: 20 },
        { id: "3", name: "Sprocket", price: 30 },
      ])
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("builds a working builder against the named table", async () => {
    expect(await DB.table("widgets").count()).toBe(3);

    const rows = await DB.table("widgets").where("name", "Sprocket").orderBy("price").get();
    expect(rows.map((row) => row.id)).toEqual(["1", "3"]);
  });

  it("types columns and values from an explicit TRow generic", async () => {
    const rows = await DB.table<WidgetTable>("widgets").where("price", ">", 15).get();

    // `rows` is WidgetTable[], not Record<string, any>[] — `name` is a string.
    const names: string[] = rows.map((row) => row.name);
    expect(names.sort()).toEqual(["Cog", "Sprocket"]);
  });

  it("returns an independent builder per call, despite chaining being mutative", async () => {
    const builder = DB.table("widgets");
    builder.where("name", "Cog");

    // A second DB.table() call must not carry the first one's where clause.
    expect(await DB.table("widgets").count()).toBe(3);
    expect(await builder.count()).toBe(1);
  });

  it("joins an enclosing DB.transaction() and rolls back with it", async () => {
    await expect(
      DB.transaction(async () => {
        await DB.table("widgets").insert({ id: "4", name: "Gear", price: 40 });
        expect(await DB.table("widgets").count()).toBe(4);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await DB.table("widgets").count()).toBe(3);
  });

  it("resolves the transaction lazily, so a builder made before the transaction still joins it", async () => {
    const builder = DB.table("widgets").where("name", "Gear");

    await DB.transaction(async () => {
      await DB.table("widgets").insert({ id: "4", name: "Gear", price: 40 });
      // Built outside the transaction, executed inside it — the connection
      // thunk runs at the terminal, not at construction.
      expect(await builder.count()).toBe(1);
    });
  });

  describe("with a named connection", () => {
    let secondary: Kysely<any>;

    beforeEach(async () => {
      manager.extend("secondary", () => new SqliteDriver({ filename: ":memory:" }));
      secondary = manager.connection("secondary").kysely;
      await createWidgetsTable(secondary);
      await secondary
        .insertInto("widgets")
        .values({ id: "9", name: "Flywheel", price: 90 })
        .execute();
    });

    it("reads that connection, not the default one", async () => {
      const rows = await DB.table("widgets", "secondary").get();
      expect(rows.map((row) => row.id)).toEqual(["9"]);
    });

    it("ignores an enclosing default-connection transaction", async () => {
      await DB.transaction(async () => {
        // The transaction context is global ("is there an active trx"), not
        // per-connection — naming a connection means that connection, so this
        // write lands on `secondary` outside the default's transaction.
        await DB.table("widgets", "secondary").insert({ id: "10", name: "Axle", price: 100 });
        throw new Error("boom");
      }).catch(() => undefined);

      expect(await DB.table("widgets", "secondary").count()).toBe(2);
    });
  });

  describe("DB.query()", () => {
    it("works once a table is bound", async () => {
      expect(await DB.query().table("widgets").count()).toBe(3);
    });

    it("throws on a terminal when no table was ever bound", async () => {
      await expect(DB.query().get()).rejects.toThrow(/no table bound/);
    });

    it("accepts a named connection too", async () => {
      manager.extend("secondary", () => new SqliteDriver({ filename: ":memory:" }));
      await createWidgetsTable(manager.connection("secondary").kysely);

      expect(await DB.query("secondary").table("widgets").count()).toBe(0);
    });
  });
});
