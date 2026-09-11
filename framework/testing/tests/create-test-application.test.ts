import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahi/core";
import { CacheServiceProvider } from "@mahi/cache";
import { DatabaseServiceProvider, DatabaseManager, DATABASE_TOKEN, Model } from "@mahi/database";
import type { Router } from "@mahi/http";
import { HttpResponse, HttpServiceProvider } from "@mahi/http";
import { createTestApplication } from "../src/create-test-application.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = path.join(__dirname, "__fixtures__/migrations");

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  // The fixture migration creates only `id`/`name`; `Model.timestamps`
  // defaults to true, which would insert created_at/updated_at columns
  // that don't exist. Nothing here asserts on timestamps.
  timestamps: false,
}) {}

/** Minimal single-provider fixture app — this package can't depend on a real app. */
class WidgetsProvider extends ServiceProvider {
  migrations(): string {
    return FIXTURE_MIGRATIONS_DIR;
  }

  routes(router: Router): void {
    router.get("/widgets", async () => HttpResponse.json((await Widget.all()).toArray()));
    router.post("/widgets", async (request) => {
      const name = request.input("name") as string;
      const widget = await Widget.create({ id: randomUUID(), name });

      return HttpResponse.json(widget, 201);
    });
  }
}

async function bootstrapFixtureApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    migrationsPath: "database/migrations", // unused; WidgetsProvider.migrations() supplies the real path
    connections: { sqlite: { filename: process.env.DB_FILENAME } },
  });
  // The HTTP maintenance middleware reads maintenance state from the cache,
  // so an app registering HttpServiceProvider also needs a cache store.
  app.config.set("cache", { default: "array", stores: { array: {} } });

  app.register(CacheServiceProvider);
  app.register(DatabaseServiceProvider);
  app.register(HttpServiceProvider);
  app.register(WidgetsProvider);

  await app.bootstrap();

  return app;
}

describe("createTestApplication()", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
    delete process.env.APP_KEY;
    clearCurrentApp();
  });

  it("boots a working app with migrations applied, backed by a fresh temp sqlite file", async () => {
    const { app, request, cleanup } = await createTestApplication(bootstrapFixtureApp);

    try {
      expect(app.isBooted()).toBe(true);

      const dbFilename = process.env.DB_FILENAME;
      expect(dbFilename).toBeTruthy();
      expect(existsSync(dbFilename!)).toBe(true);

      const empty = await request("/widgets");
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual([]);

      const created = await request("/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Sprocket" }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody).toMatchObject({ name: "Sprocket" });

      const list = await request("/widgets");
      expect(await list.json()).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("cleanup() removes the temp directory", async () => {
    const { cleanup } = await createTestApplication(bootstrapFixtureApp);
    const tmpDir = path.dirname(process.env.DB_FILENAME!);

    expect(existsSync(tmpDir)).toBe(true);
    await cleanup();
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("runs options.configure() after bootstrap but before migrations", async () => {
    let configuredCalled = false;

    const { cleanup } = await createTestApplication(bootstrapFixtureApp, {
      configure: (app) => {
        configuredCalled = true;
        expect(app.isBooted()).toBe(true);
      },
    });

    expect(configuredCalled).toBe(true);
    await cleanup();
  });

  it("isolates each call to a distinct temp sqlite file", async () => {
    const first = await createTestApplication(bootstrapFixtureApp);
    const firstDb = process.env.DB_FILENAME;

    const second = await createTestApplication(bootstrapFixtureApp);
    const secondDb = process.env.DB_FILENAME;

    expect(firstDb).not.toBe(secondDb);

    await second.cleanup();
    await first.cleanup();
  });

  /**
   * `cleanup()` must terminate the app, not just delete the temp
   * directory: otherwise the sqlite handle stays open (holding a file
   * descriptor for the rest of the run, on a file that no longer exists)
   * and every provider's teardown is skipped entirely.
   */
  it("cleanup() terminates the application", async () => {
    const { app, cleanup } = await createTestApplication(bootstrapFixtureApp);

    expect(app.isTerminated()).toBe(false);
    await cleanup();
    expect(app.isTerminated()).toBe(true);
  });

  it("cleanup() closes the database, so a query afterwards throws", async () => {
    const { app, cleanup } = await createTestApplication(bootstrapFixtureApp);
    const db = app.make<DatabaseManager>(DATABASE_TOKEN);
    const kysely = db.connection().kysely;

    // Works before cleanup...
    await kysely
      .selectFrom("widgets" as any)
      .selectAll()
      .execute();

    await cleanup();

    await expect(
      kysely
        .selectFrom("widgets" as any)
        .selectAll()
        .execute(),
    ).rejects.toThrow();
  });

  /**
   * `process.env` is process-global and outlives the Application, so a
   * test file that pointed `DB_FILENAME` at its own temp database left it
   * pointing there for every file that ran afterwards in the same worker
   * — at a path `cleanup()` had already deleted.
   */
  describe("cleanup() restores the process.env keys it mutated", () => {
    it("deletes keys that were previously unset", async () => {
      delete process.env.DB_FILENAME;
      delete process.env.NODE_ENV;

      const { cleanup } = await createTestApplication(bootstrapFixtureApp);
      expect(process.env.DB_FILENAME).toBeTruthy();

      await cleanup();

      // Deleted, not set to the string "undefined" — which is what
      // `env[key] = undefined` would have produced.
      expect("DB_FILENAME" in process.env).toBe(false);
      expect("NODE_ENV" in process.env).toBe(false);
    });

    it("restores keys that had a prior value", async () => {
      process.env.DB_FILENAME = "/pre-existing.sqlite";
      process.env.NODE_ENV = "development";

      const { cleanup } = await createTestApplication(bootstrapFixtureApp);
      expect(process.env.NODE_ENV).toBe("test");

      await cleanup();

      expect(process.env.DB_FILENAME).toBe("/pre-existing.sqlite");
      expect(process.env.NODE_ENV).toBe("development");
    });

    it("leaves an APP_KEY the caller supplied untouched", async () => {
      const key = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      process.env.APP_KEY = key;

      const { cleanup } = await createTestApplication(bootstrapFixtureApp);
      expect(process.env.APP_KEY).toBe(key);

      await cleanup();

      expect(process.env.APP_KEY).toBe(key);
    });
  });
});
