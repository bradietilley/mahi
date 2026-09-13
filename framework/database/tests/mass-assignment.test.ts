import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { MassAssignmentError, Model } from "../src/model.js";

interface WidgetAttributes {
  id: string;
  name: string;
  role: string;
}

type WidgetTable = WidgetAttributes;

/** Default posture: no `fillable`/`guarded`. Everything is mass-assignable. */
class OpenWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

/** Allow-list: only `name` may be mass-assigned. */
class FillableWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
  fillable: ["id", "name"],
}) {}

/** Block-list: `role` is guarded; everything else is fillable. */
class GuardedWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
  guarded: ["role"],
}) {}

/** Totally guarded: empty `fillable` + `guarded = ["*"]`. */
class LockedWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
  guarded: ["*"],
}) {}

describe("Mass-assignment protection", () => {
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
      .addColumn("role", "text", (col) => col.notNull().defaultTo("user"))
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("the framework default (no fillable/guarded) mass-assigns every attribute", async () => {
    const created = await OpenWidget.create({ id: "1", name: "Sprocket", role: "admin" });
    expect(created.role).toBe("admin");
  });

  it("a non-empty fillable allow-list drops keys not on it", async () => {
    await FillableWidget.create({ id: "1", name: "Sprocket", role: "admin" });
    // role wasn't fillable, so it was never inserted, the DB default wins.
    const stored = await FillableWidget.find("1");
    expect(stored!.name).toBe("Sprocket");
    expect(stored!.role).toBe("user");
  });

  it("a guarded block-list drops the guarded keys but keeps the rest", async () => {
    await GuardedWidget.create({ id: "1", name: "Sprocket", role: "admin" });
    const stored = await GuardedWidget.find("1");
    expect(stored!.name).toBe("Sprocket");
    expect(stored!.role).toBe("user");
  });

  it("fill() honors the same policy as construction", async () => {
    const widget = new GuardedWidget({ id: "1", name: "Sprocket" });
    widget.fill({ name: "Cog", role: "admin" });
    expect((widget as unknown as WidgetTable).name).toBe("Cog");
    expect((widget as unknown as WidgetTable).role).toBeUndefined();
  });

  it("a totally-guarded model throws MassAssignmentError on a disallowed key", () => {
    expect(() => new LockedWidget({ id: "1", name: "Sprocket" })).toThrow(MassAssignmentError);
  });

  it("forceFill() bypasses the policy", async () => {
    const widget = new GuardedWidget({ id: "1", name: "Sprocket" });
    widget.forceFill({ role: "admin" });
    expect((widget as unknown as WidgetTable).role).toBe("admin");
  });

  it("a direct attribute write bypasses the policy (guards mass assignment only)", async () => {
    const widget = new GuardedWidget({ id: "1", name: "Sprocket" });
    (widget as unknown as WidgetTable).role = "admin";
    expect((widget as unknown as WidgetTable).role).toBe("admin");
  });

  it("isFillable() / totallyGuarded() reflect the declared policy", () => {
    expect(OpenWidget.isFillable("role")).toBe(true);
    expect(FillableWidget.isFillable("role")).toBe(false);
    expect(FillableWidget.isFillable("name")).toBe(true);
    expect(GuardedWidget.isFillable("role")).toBe(false);
    expect(GuardedWidget.isFillable("name")).toBe(true);
    expect(LockedWidget.totallyGuarded()).toBe(true);
    expect(OpenWidget.totallyGuarded()).toBe(false);
  });
});
