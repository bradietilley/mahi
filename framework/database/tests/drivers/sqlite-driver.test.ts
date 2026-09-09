import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";

/**
 * Read a pragma off the driver's underlying better-sqlite3 handle.
 *
 * `simple: true` returns the value itself; without it better-sqlite3 hands
 * back a row object, which compares equal to nothing useful.
 */
function pragma(driver: SqliteDriver, name: string): number {
  const db = (
    driver as unknown as { db: { pragma(source: string, options: { simple: true }): unknown } }
  ).db;

  return db.pragma(name, { simple: true }) as number;
}

describe("SqliteDriver", () => {
  it("connects synchronously and exposes a working Kysely instance", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    await driver.kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await driver.kysely
      .insertInto("widgets" as any)
      .values({ id: "1", name: "Sprocket" })
      .execute();

    const row = await driver.kysely
      .selectFrom("widgets" as any)
      .selectAll()
      .executeTakeFirst();

    expect(row).toMatchObject({ id: "1", name: "Sprocket" });
  });

  /**
   * WAL permits concurrent readers but only ONE writer, and sqlite's own
   * default `busy_timeout` is 0 — so a second process writing at the same
   * moment fails instantly with SQLITE_BUSY rather than waiting for the lock.
   *
   * That is not an exotic condition, it is simply what two simultaneous writes
   * look like, and the symptom is data loss rather than an obvious error
   * because the losing caller may well be swallowing the exception. Found in
   * an app where 24 concurrent writers lost several of their writes.
   */
  it("waits for a held write lock instead of failing immediately", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    expect(driver.kysely).toBeDefined();
    expect(pragma(driver, "busy_timeout")).toBe(5000);
  });

  it("lets an application choose its own busy timeout", () => {
    expect(
      pragma(new SqliteDriver({ filename: ":memory:", busyTimeout: 250 }), "busy_timeout"),
    ).toBe(250);

    // 0 restores sqlite's own behaviour, for an app that would rather fail
    // fast than block.
    expect(pragma(new SqliteDriver({ filename: ":memory:", busyTimeout: 0 }), "busy_timeout")).toBe(
      0,
    );
  });

  it("keeps WAL and foreign keys on", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    expect(pragma(driver, "foreign_keys")).toBe(1);
  });

  it("has no connect() — construction is fully synchronous", () => {
    const driver = new SqliteDriver({ filename: ":memory:" });
    expect((driver as any).connect).toBeUndefined();
  });

  it("disconnect() closes the handle, so later queries throw", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });
    await driver.kysely.schema.createTable("widgets").addColumn("id", "text").execute();

    await driver.disconnect();

    await expect(
      driver.kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .execute(),
    ).rejects.toThrow();
  });

  /**
   * `terminate()` is idempotent and a test's `cleanup()` may close a
   * driver something else already closed — so a second `disconnect()` has
   * to be a no-op. Kysely's own `destroy()` is not: it throws
   * `db.prepare is not a function` the second time.
   */
  it("disconnect() is idempotent", async () => {
    const driver = new SqliteDriver({ filename: ":memory:" });

    await driver.disconnect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });
});
