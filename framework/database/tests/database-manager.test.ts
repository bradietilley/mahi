import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { Model } from "../src/model.js";

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

function makeManager(): DatabaseManager {
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);
  setCurrentApp(app);

  return manager;
}

describe("DatabaseManager.transaction()", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("is a convenience wrapper equivalent to transaction(this.driver().kysely, callback), and static Model calls inside participate", async () => {
    const manager = makeManager();
    const kysely = manager.driver().kysely;
    await kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await manager.transaction(async () => {
      await Widget.create({ id: "1", name: "Sprocket" });
    });

    expect((await Widget.all()).length).toBe(1);
  });

  it("rolls back on a thrown error, same as the standalone transaction() helper", async () => {
    const manager = makeManager();
    const kysely = manager.driver().kysely;
    await kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await expect(
      manager.transaction(async () => {
        await Widget.create({ id: "1", name: "Sprocket" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await Widget.all()).length).toBe(0);
  });

  it("resolves a named driver's connection when driverName is given", async () => {
    const manager = makeManager();
    manager.extend("secondary", () => new SqliteDriver({ filename: ":memory:" }));

    const secondaryKysely = manager.driver("secondary").kysely;
    await secondaryKysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await manager.transaction(async (trx) => {
      await trx.insertInto("widgets").values({ id: "1", name: "Sprocket" }).execute();
    }, "secondary");

    const rows = await secondaryKysely.selectFrom("widgets").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("a transaction on a NAMED connection does not hijack default-connection calls", async () => {
    const manager = makeManager();
    manager.extend("secondary", () => new SqliteDriver({ filename: ":memory:" }));

    for (const kysely of [manager.driver().kysely, manager.driver("secondary").kysely]) {
      await kysely.schema
        .createTable("widgets")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();
    }

    // `Widget` is bound to the DEFAULT connection. Under the old
    // single-slot context it would have joined the secondary
    // connection's transaction and written to the wrong database.
    await manager.transaction(async () => {
      await Widget.create({ id: "1", name: "Sprocket" });
    }, "secondary");

    expect(await manager.driver().kysely.selectFrom("widgets").selectAll().execute()).toHaveLength(
      1,
    );
    expect(
      await manager.driver("secondary").kysely.selectFrom("widgets").selectAll().execute(),
    ).toHaveLength(0);
  });

  it("a named-connection DB.table() inside that connection's transaction joins it and rolls back with it", async () => {
    const manager = makeManager();
    manager.extend("secondary", () => new SqliteDriver({ filename: ":memory:" }));

    await manager
      .driver("secondary")
      .kysely.schema.createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await expect(
      manager.transaction(async () => {
        await manager.table("widgets", "secondary").insert({ id: "1", name: "Sprocket" });
        throw new Error("boom");
      }, "secondary"),
    ).rejects.toThrow("boom");

    expect(
      await manager.driver("secondary").kysely.selectFrom("widgets").selectAll().execute(),
    ).toHaveLength(0);
  });
});
