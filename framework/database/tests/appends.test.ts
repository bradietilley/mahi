import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";

interface WidgetAttributes {
  id: string;
  width: number;
  height: number;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("appended attributes (append/setAppended/getAppended)", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();
    await kysely.schema
      .createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("width", "integer", (col) => col.notNull())
      .addColumn("height", "integer", (col) => col.notNull())
      .execute();

    await Widget.create({ id: "w1", width: 3, height: 4 });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("append()/setAppended() attach a value readable off the instance", async () => {
    const widget = await Widget.findOrFail("w1");
    expect(widget.hasAppended("area")).toBe(false);

    widget.append("area", 12);
    expect(widget.hasAppended("area")).toBe(true);
    expect(widget.getAppended("area")).toBe(12);
    expect((widget as any).area).toBe(12);
  });

  it("append() and setAppended() are equivalent", async () => {
    const widget = await Widget.findOrFail("w1");
    widget.setAppended("label", "hello");
    expect((widget as any).label).toBe("hello");
  });

  it("appended values are NOT serialized by the model's toJSON() (that's the resource's job)", async () => {
    const widget = await Widget.findOrFail("w1");
    widget.append("area", 12);
    const json = widget.toJSON();
    expect(json).not.toHaveProperty("area");
    expect(json).toMatchObject({ id: "w1", width: 3, height: 4 });
  });

  it("getAppended() returns undefined for an un-set name", async () => {
    const widget = await Widget.findOrFail("w1");
    expect(widget.getAppended("nope")).toBeUndefined();
    expect(widget.hasAppended("nope")).toBe(false);
  });

  it("a null appended value is distinguishable from 'never appended'", async () => {
    const widget = await Widget.findOrFail("w1");
    widget.append("maybe", null);
    expect(widget.hasAppended("maybe")).toBe(true);
    expect(widget.getAppended("maybe")).toBeNull();
  });
});
