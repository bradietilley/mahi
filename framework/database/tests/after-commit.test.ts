import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { transaction } from "../src/transaction.js";
import {
  afterCommit,
  afterCommitOn,
  afterRollback,
  inTransaction,
} from "../src/transaction-context.js";

describe("after-commit callbacks", () => {
  let driver: SqliteDriver;
  let app: Application;

  beforeEach(async () => {
    driver = new SqliteDriver({ filename: ":memory:" });
    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .execute();

    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);
  });

  afterEach(async () => {
    clearCurrentApp();
    await driver.disconnect();
  });

  describe("outside a transaction", () => {
    it("runs the callback immediately and awaits it", async () => {
      const order: string[] = [];

      await afterCommit(async () => {
        await Promise.resolve();
        order.push("callback");
      });
      order.push("after");

      expect(order).toEqual(["callback", "after"]);
    });

    it("never runs an afterRollback callback. Nothing can roll back", async () => {
      let ran = false;
      afterRollback(() => {
        ran = true;
      });
      expect(ran).toBe(false);
    });

    it("inTransaction() is false", () => {
      expect(inTransaction()).toBe(false);
    });
  });

  describe("inside a committed transaction", () => {
    it("runs exactly once, and only after the commit", async () => {
      const order: string[] = [];

      await transaction(driver.kysely, async (trx) => {
        await afterCommit(() => {
          order.push("callback");
        });
        await trx.insertInto("widgets").values({ id: "1" }).execute();
        order.push("still-inside");
      });
      order.push("returned");

      expect(order).toEqual(["still-inside", "callback", "returned"]);
    });

    it("sees the committed data on the root connection", async () => {
      let visible = -1;

      await transaction(driver.kysely, async (trx) => {
        await trx.insertInto("widgets").values({ id: "1" }).execute();
        await afterCommit(async () => {
          // The root connection, not the transaction's. This is what a
          // worker in another process would see.
          const rows = await driver.kysely.selectFrom("widgets").selectAll().execute();
          visible = rows.length;
        });
      });

      expect(visible).toBe(1);
    });

    it("runs callbacks in registration order", async () => {
      const order: number[] = [];

      await transaction(driver.kysely, async () => {
        await afterCommit(() => void order.push(1));
        await afterCommit(() => void order.push(2));
        await afterCommit(() => void order.push(3));
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it("a throwing callback is isolated: the rest still run and the transaction still resolves", async () => {
      const ran: string[] = [];
      const logged: string[] = [];
      app.logger.error = (message: string) => void logged.push(message);

      await expect(
        transaction(driver.kysely, async () => {
          await afterCommit(() => void ran.push("first"));
          await afterCommit(() => {
            throw new Error("callback boom");
          });
          await afterCommit(() => void ran.push("third"));
        }),
      ).resolves.toBeUndefined();

      expect(ran).toEqual(["first", "third"]);
      expect(logged.some((m) => m.includes("after-commit"))).toBe(true);
    });
  });

  describe("inside a rolled-back transaction", () => {
    it("never runs the after-commit callback", async () => {
      let ran = false;

      await expect(
        transaction(driver.kysely, async () => {
          await afterCommit(() => {
            ran = true;
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(ran).toBe(false);
    });

    it("runs afterRollback callbacks instead", async () => {
      const ran: string[] = [];

      await expect(
        transaction(driver.kysely, async () => {
          afterRollback(() => void ran.push("rollback"));
          await afterCommit(() => void ran.push("commit"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(ran).toEqual(["rollback"]);
    });

    it("still surfaces the original error even when a rollback callback throws", async () => {
      app.logger.error = () => {};

      await expect(
        transaction(driver.kysely, async () => {
          afterRollback(() => {
            throw new Error("rollback callback boom");
          });
          throw new Error("the real problem");
        }),
      ).rejects.toThrow("the real problem");
    });
  });

  describe("nesting", () => {
    it("a callback registered in a nested transaction waits for the OUTERMOST commit", async () => {
      const order: string[] = [];

      await transaction(driver.kysely, async () => {
        await transaction(driver.kysely, async () => {
          await afterCommit(() => void order.push("callback"));
        });
        // The inner "commit" (a RELEASE SAVEPOINT) is not durable, so
        // nothing may have run yet.
        order.push("inner-done");
      });

      expect(order).toEqual(["inner-done", "callback"]);
    });

    it("discards callbacks registered inside a savepoint that rolls back", async () => {
      const ran: string[] = [];

      await transaction(driver.kysely, async () => {
        await afterCommit(() => void ran.push("outer"));

        // The caller catches the inner failure, the outer transaction
        // survives, but the inner work (and its callbacks) is gone.
        await expect(
          transaction(driver.kysely, async () => {
            await afterCommit(() => void ran.push("inner"));
            throw new Error("inner boom");
          }),
        ).rejects.toThrow("inner boom");
      });

      expect(ran).toEqual(["outer"]);
    });

    it("keeps callbacks from a nested transaction that succeeded", async () => {
      const ran: string[] = [];

      await transaction(driver.kysely, async () => {
        await transaction(driver.kysely, async () => {
          await afterCommit(() => void ran.push("inner"));
        });
        await afterCommit(() => void ran.push("outer"));
      });

      expect(ran).toEqual(["inner", "outer"]);
    });

    it("discards everything when the outermost transaction rolls back, however deep", async () => {
      const ran: string[] = [];

      await expect(
        transaction(driver.kysely, async () => {
          await transaction(driver.kysely, async () => {
            await afterCommit(() => void ran.push("inner"));
          });
          throw new Error("outer boom");
        }),
      ).rejects.toThrow("outer boom");

      expect(ran).toEqual([]);
    });
  });

  describe("per-connection scoping", () => {
    it("afterCommitOn() ignores a transaction open on a different connection", async () => {
      const other = new SqliteDriver({ filename: ":memory:" });
      const order: string[] = [];

      await transaction(driver.kysely, async () => {
        // This callback belongs to `other`, which has no transaction,
        // so it must run immediately rather than waiting for a commit it
        // has nothing to do with.
        await afterCommitOn(other.kysely, () => void order.push("other"));
        order.push("inside");
      });

      expect(order).toEqual(["other", "inside"]);
      await other.disconnect();
    });

    it("afterCommitOn() defers against its own connection's transaction", async () => {
      const order: string[] = [];

      await transaction(driver.kysely, async () => {
        await afterCommitOn(driver.kysely, () => void order.push("deferred"));
        order.push("inside");
      });

      expect(order).toEqual(["inside", "deferred"]);
    });
  });

  it("a callback may open its own real transaction (not a savepoint on a released one)", async () => {
    await transaction(driver.kysely, async (trx) => {
      await trx.insertInto("widgets").values({ id: "1" }).execute();
      await afterCommit(async () => {
        await transaction(driver.kysely, async (inner) => {
          await inner.insertInto("widgets").values({ id: "2" }).execute();
        });
      });
    });

    const rows = await driver.kysely.selectFrom("widgets").selectAll().execute();
    expect(rows.map((r: any) => r.id).sort()).toEqual(["1", "2"]);
  });
});
