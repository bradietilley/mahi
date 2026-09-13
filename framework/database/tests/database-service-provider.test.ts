import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, clearCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../src/database-manager.js";
import { DatabaseServiceProvider, DATABASE_TOKEN } from "../src/database-service-provider.js";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";

afterEach(() => {
  clearCurrentApp();
});

function sqliteApp(
  connections: Record<string, unknown> = { sqlite: { driver: "sqlite", filename: ":memory:" } },
): Application {
  const app = new Application();
  app.config.set("database", { default: "sqlite", connections });
  app.register(DatabaseServiceProvider);

  return app;
}

describe("DatabaseServiceProvider.shutdown()", () => {
  it("disconnects every connection that was actually resolved", async () => {
    const app = sqliteApp({
      sqlite: { driver: "sqlite", filename: ":memory:" },
      analytics: { driver: "sqlite", filename: ":memory:" },
    });
    await app.bootstrap();

    const manager = app.make<DatabaseManager>(DATABASE_TOKEN);
    const primary = manager.connection() as SqliteDriver;
    const analytics = manager.connection("analytics") as SqliteDriver;
    const primarySpy = vi.spyOn(primary, "disconnect");
    const analyticsSpy = vi.spyOn(analytics, "disconnect");

    await app.terminate();

    expect(primarySpy).toHaveBeenCalledOnce();
    expect(analyticsSpy).toHaveBeenCalledOnce();
  });

  /**
   * A named connection nothing ever touched must not be *constructed*
   * here purely to be torn down, for MySQL/Postgres that means building
   * a pool during shutdown, opening connections in order to close them.
   */
  it("does not construct a connection that was never used", async () => {
    const app = sqliteApp({
      sqlite: { driver: "sqlite", filename: ":memory:" },
      analytics: { driver: "sqlite", filename: ":memory:" },
    });
    await app.bootstrap();

    const manager = app.make<DatabaseManager>(DATABASE_TOKEN);
    // `boot()` resolves the default connection; `analytics` is untouched.
    expect(manager.resolvedDriverNames()).toEqual(["sqlite"]);

    await app.terminate();

    expect(manager.resolvedDriverNames()).toEqual([]);
  });

  it("closes the sqlite handle, so a query after terminate() throws", async () => {
    const app = sqliteApp();
    await app.bootstrap();

    const manager = app.make<DatabaseManager>(DATABASE_TOKEN);
    const kysely = manager.connection().kysely;
    await kysely.schema.createTable("widgets").addColumn("id", "text").execute();

    await app.terminate();

    await expect(
      kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .execute(),
    ).rejects.toThrow();
  });

  /**
   * Shutdown can run after a boot that threw before this provider's own
   * `boot()`, `make()`ing the manager there would build the thing we are
   * trying not to leave open.
   */
  it("is a no-op when the database token was never resolved", async () => {
    const app = sqliteApp();
    const provider = new DatabaseServiceProvider(app);
    // Registered (so the token is bound) but never resolved.
    provider.register();

    expect(app.has(DATABASE_TOKEN)).toBe(true);
    expect(app.isResolved(DATABASE_TOKEN)).toBe(false);

    await expect(provider.shutdown()).resolves.toBeUndefined();
    expect(app.isResolved(DATABASE_TOKEN)).toBe(false);
  });

  it("logs a failing disconnect rather than aborting the rest of shutdown", async () => {
    const app = sqliteApp();
    await app.bootstrap();

    const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});
    const manager = app.make<DatabaseManager>(DATABASE_TOKEN);
    vi.spyOn(manager.connection() as SqliteDriver, "disconnect").mockRejectedValue(
      new Error("boom"),
    );

    await expect(app.terminate()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("failed to disconnect"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
