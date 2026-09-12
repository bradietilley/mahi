import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import type { GlobalScope } from "../src/global-scope.js";
import type { EloquentBuilder } from "../src/eloquent-builder.js";

interface WidgetAttributes {
  id: string;
  name: string;
  status: string;
  category: string;
}

class ActiveScope implements GlobalScope {
  apply(builder: EloquentBuilder<any>): void {
    builder.where("status", "active");
  }
}

class WidgetsCategoryScope implements GlobalScope {
  apply(builder: EloquentBuilder<any>): void {
    builder.where("category", "widgets");
  }
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
}) {
  static override scopes: GlobalScope[] = [new ActiveScope(), new WidgetsCategoryScope()];
}

class PlainWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
}) {
  // no scopes declared -- should behave exactly like today's unscoped Model
}

describe("GlobalScope", () => {
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
      .addColumn("status", "text", (col) => col.notNull())
      .addColumn("category", "text", (col) => col.notNull().defaultTo("widgets"))
      .execute();

    await manager
      .driver()
      .kysely.insertInto("widgets")
      .values([
        { id: "1", name: "Sprocket", status: "active", category: "widgets" },
        { id: "2", name: "Cog", status: "archived", category: "widgets" },
        { id: "3", name: "Gear", status: "active", category: "gadgets" },
      ])
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("a declared scope is applied automatically to query()", async () => {
    const rows = await Widget.query().get();
    expect(rows.length).toBe(1);
    expect(rows.first()).toMatchObject({ name: "Sprocket" });
  });

  it("a declared scope is applied automatically to all()", async () => {
    const rows = await Widget.all();
    expect(rows.length).toBe(1);
  });

  it("a declared scope is applied automatically to find()", async () => {
    expect(await Widget.find("1")).toMatchObject({ name: "Sprocket" });
    expect(await Widget.find("2")).toBeUndefined(); // excluded by the scope
  });

  it("queryWithoutScopes() bypasses every declared scope", async () => {
    const rows = await Widget.queryWithoutScopes().get();
    expect(rows.length).toBe(3);
  });

  it("withoutGlobalScope(ScopeClass) removes exactly that one scope", async () => {
    const rows = await Widget.withoutGlobalScope(ActiveScope).get();
    // WidgetsCategoryScope still applies: rows 1 and 2 (both category="widgets"), row 3 excluded.
    expect(rows.length).toBe(2);
  });

  it("withoutGlobalScopes([...]) removes SEVERAL scope classes at once", async () => {
    const rows = await Widget.withoutGlobalScopes([ActiveScope, WidgetsCategoryScope]).get();
    expect(rows.length).toBe(3);
  });

  it("withoutGlobalScopes() with no arguments removes every scope, same as queryWithoutScopes()", async () => {
    const rows = await Widget.withoutGlobalScopes().get();
    expect(rows.length).toBe(3);
  });

  it("a model with no declared scopes behaves exactly like today's unscoped Model", async () => {
    const rows = await PlainWidget.all();
    expect(rows.length).toBe(3);
  });
});
