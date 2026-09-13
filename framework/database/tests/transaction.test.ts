import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { transaction } from "../src/transaction.js";

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("transaction()", () => {
  let driver: SqliteDriver;

  beforeEach(async () => {
    driver = new SqliteDriver({ filename: ":memory:" });
    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    // Static Model access resolves its connection via app(), wire up a
    // minimal Application whose DatabaseManager points at this driver, so
    // Widget.xxx() calls outside of a transaction() have somewhere to go.
    const app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("commits both inserts on success", async () => {
    await transaction(driver.kysely, async () => {
      await Widget.create({ id: "1", name: "Sprocket" });
      await Widget.create({ id: "2", name: "Cog" });
    });

    const rows = await Widget.all();
    expect(rows.length).toBe(2);
  });

  it("rolls back all writes if the callback throws", async () => {
    await expect(
      transaction(driver.kysely, async () => {
        await Widget.create({ id: "1", name: "Sprocket" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await Widget.all();
    expect(rows.length).toBe(0);
  });

  it("static Model calls made inside the callback automatically participate in the transaction", async () => {
    await transaction(driver.kysely, async () => {
      await Widget.create({ id: "1", name: "Sprocket" });

      // Visible within the same transaction...
      expect((await Widget.all()).length).toBe(1);
    });

    // ...and committed after it resolves.
    expect((await Widget.all()).length).toBe(1);
  });

  it("the callback also receives the raw transactional Kysely instance for escape-hatch use", async () => {
    await transaction(driver.kysely, async (trx) => {
      await trx.insertInto("widgets").values({ id: "1", name: "Sprocket" }).execute();
    });

    expect((await Widget.all()).length).toBe(1);
  });
});

describe("transaction() nesting", () => {
  let driver: SqliteDriver;

  beforeEach(async () => {
    driver = new SqliteDriver({ filename: ":memory:" });
    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    const app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("completes rather than deadlocking, committing both levels' writes", async () => {
    await transaction(driver.kysely, async () => {
      await Widget.create({ id: "outer", name: "Outer" });

      await transaction(driver.kysely, async () => {
        await Widget.create({ id: "inner", name: "Inner" });
      });
    });

    const names = (await Widget.all()).toArray().map((w) => (w as any).id);
    expect(names.sort()).toEqual(["inner", "outer"]);
  });

  it("nests three deep", async () => {
    await transaction(driver.kysely, async () => {
      await Widget.create({ id: "1", name: "One" });
      await transaction(driver.kysely, async () => {
        await Widget.create({ id: "2", name: "Two" });
        await transaction(driver.kysely, async () => {
          await Widget.create({ id: "3", name: "Three" });
        });
      });
    });

    expect((await Widget.all()).length).toBe(3);
  });

  it("an inner rollback (via savepoint) leaves the outer transaction intact", async () => {
    await transaction(driver.kysely, async () => {
      await Widget.create({ id: "outer", name: "Outer" });

      await expect(
        transaction(driver.kysely, async () => {
          await Widget.create({ id: "inner", name: "Inner" });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");

      // The outer transaction is still usable after the inner one rolled
      // back to its savepoint. That's the whole point of nesting.
      await Widget.create({ id: "after", name: "After" });
    });

    const ids = (await Widget.all()).toArray().map((w) => (w as any).id);
    expect(ids.sort()).toEqual(["after", "outer"]);
  });

  it("an outer rollback undoes inner work that already 'committed'", async () => {
    await expect(
      transaction(driver.kysely, async () => {
        await transaction(driver.kysely, async () => {
          await Widget.create({ id: "inner", name: "Inner" });
        });
        throw new Error("outer boom");
      }),
    ).rejects.toThrow("outer boom");

    expect((await Widget.all()).length).toBe(0);
  });

  it("accepts the transactional instance itself as `db` and still nests via savepoint", async () => {
    await transaction(driver.kysely, async (trx) => {
      await Widget.create({ id: "outer", name: "Outer" });

      await expect(
        transaction(trx, async () => {
          await Widget.create({ id: "inner", name: "Inner" });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");

      await Widget.create({ id: "after", name: "After" });
    });

    const ids = (await Widget.all()).toArray().map((w) => (w as any).id);
    expect(ids.sort()).toEqual(["after", "outer"]);
  });

  it("sibling nested transactions each get their own savepoint", async () => {
    await transaction(driver.kysely, async () => {
      await transaction(driver.kysely, async () => {
        await Widget.create({ id: "a", name: "A" });
      });

      await expect(
        transaction(driver.kysely, async () => {
          await Widget.create({ id: "b", name: "B" });
          throw new Error("b boom");
        }),
      ).rejects.toThrow("b boom");

      await transaction(driver.kysely, async () => {
        await Widget.create({ id: "c", name: "C" });
      });
    });

    const ids = (await Widget.all()).toArray().map((w) => (w as any).id);
    expect(ids.sort()).toEqual(["a", "c"]);
  });

  it("a transaction on a DIFFERENT connection is genuinely independent", async () => {
    const other = new SqliteDriver({ filename: ":memory:" });
    await other.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await transaction(driver.kysely, async (outerTrx) => {
      await outerTrx.insertInto("widgets").values({ id: "1", name: "Default" }).execute();

      // Commits on its own, independent of the outer connection's fate.
      await transaction(other.kysely, async (innerTrx) => {
        await innerTrx.insertInto("widgets").values({ id: "1", name: "Other" }).execute();
      });
    });

    expect(await other.kysely.selectFrom("widgets").selectAll().execute()).toHaveLength(1);
    await other.disconnect();
  });
});
