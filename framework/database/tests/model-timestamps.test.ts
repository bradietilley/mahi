import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";

interface WidgetAttributes {
  id: string;
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

class TimestampedWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: true,
  casts: { created_at: Cast.string(), updated_at: Cast.string() },
}) {}

class PlainWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

interface CreatedOnlyWidgetAttributes {
  id: string;
  name: string;
  created_at?: string | null;
}

/** A "create-only" table: has `created_at` but no `updated_at`. */
class CreatedOnlyWidget extends Model<CreatedOnlyWidgetAttributes>()({
  table: "created_only_widgets",
  primaryKey: "id",
  timestamps: { createdAt: "created_at", updatedAt: null },
  casts: { created_at: Cast.string() },
}) {}

describe("Model timestamps", () => {
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
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text")
      .execute();

    await manager
      .driver()
      .kysely.schema.createTable("created_only_widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("created_at", "text")
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("timestamps = false never touches timestamp columns", async () => {
    const created = await PlainWidget.create({ id: "1", name: "Sprocket" });
    expect(created.created_at).toBeUndefined();
    expect(created.updated_at).toBeUndefined();

    await PlainWidget.update("1", { name: "Cog" });
    const updated = await PlainWidget.find("1");
    expect(updated!.updated_at).toBeNull();
  });

  it("timestamps defaults to true (Laravel-faithful), stamping created_at/updated_at", async () => {
    // A model that declares neither timestamps nor updatedAtColumn gets
    // the framework default (true) — its table here has both columns.
    class DefaultWidget extends Model<WidgetAttributes>()({
      table: "widgets",
      primaryKey: "id",
    }) {}

    const created = await DefaultWidget.create({ id: "1", name: "Sprocket" });
    expect(created.created_at).toBeTruthy();
    expect(created.updated_at).toBeTruthy();
  });

  it("timestamps = true stamps created_at and updated_at on create()", async () => {
    const created = await TimestampedWidget.create({ id: "1", name: "Sprocket" });

    expect(created.created_at).toBeTruthy();
    expect(created.updated_at).toBeTruthy();
    expect(new Date(created.created_at!).toString()).not.toBe("Invalid Date");
  });

  it("timestamps = true stamps updated_at (only) on update()", async () => {
    const created = await TimestampedWidget.create({ id: "1", name: "Sprocket" });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await TimestampedWidget.update("1", { name: "Cog" });

    const updated = await TimestampedWidget.find("1");
    expect(updated!.created_at).toBe(created.created_at);
    expect(updated!.updated_at).not.toBe(created.updated_at);
  });

  it("explicit caller-supplied timestamp values win over auto-stamping on create()", async () => {
    const created = await TimestampedWidget.create({
      id: "1",
      name: "Sprocket",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });

    expect(created.created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(created.updated_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("explicit caller-supplied updated_at wins over auto-stamping on update()", async () => {
    await TimestampedWidget.create({
      id: "1",
      name: "Sprocket",
      created_at: null,
      updated_at: null,
    });

    await TimestampedWidget.update("1", { name: "Cog", updated_at: "2020-01-01T00:00:00.000Z" });

    const updated = await TimestampedWidget.find("1");
    expect(updated!.updated_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("updatedAtColumn = null stamps created_at only, never touching updated_at", async () => {
    const created = await CreatedOnlyWidget.create({ id: "1", name: "Sprocket" });
    expect(created.created_at).toBeTruthy();

    // An update() must not try to write the non-existent updated_at column.
    await CreatedOnlyWidget.update("1", { name: "Cog" });
    const updated = await CreatedOnlyWidget.find("1");
    expect(updated!.name).toBe("Cog");
    expect(updated!.created_at).toBe(created.created_at);
    expect("updated_at" in (updated as object)).toBe(false);
  });
});
