import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";

interface WidgetAttributes {
  id: string;
  name: string;
  deleted_at: string | null;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
  softDeletes: true,
}) {}

describe("SoftDeletes", () => {
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
      .addColumn("deleted_at", "text")
      .execute();

    await Widget.create({ id: "1", name: "Sprocket", deleted_at: null });
    await Widget.create({ id: "2", name: "Cog", deleted_at: null });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("delete() leaves the row in the table with deleted_at set", async () => {
    await Widget.delete("1");

    const raw = await Widget.withTrashed().where("id", "1").first();
    expect(raw).toBeTruthy();
    expect(raw!.deleted_at).not.toBeNull();
  });

  it("all()/find() exclude soft-deleted rows by default", async () => {
    await Widget.delete("1");

    expect((await Widget.all()).length).toBe(1);
    expect(await Widget.find("1")).toBeUndefined();
    expect(await Widget.find("2")).toMatchObject({ name: "Cog" });
  });

  it("withTrashed() includes soft-deleted rows", async () => {
    await Widget.delete("1");

    const rows = await Widget.withTrashed().get();
    expect(rows.length).toBe(2);
  });

  it("onlyTrashed() returns only soft-deleted rows", async () => {
    await Widget.delete("1");

    const rows = await Widget.onlyTrashed().get();
    expect(rows.length).toBe(1);
    expect(rows.first()).toMatchObject({ name: "Sprocket" });
  });

  it("restore() makes a soft-deleted row visible again via all()", async () => {
    await Widget.delete("1");
    expect((await Widget.all()).length).toBe(1);

    await (await Widget.withTrashed().where("id", "1").first())!.restore();
    expect((await Widget.all()).length).toBe(2);
    expect(await Widget.find("1")).toMatchObject({ name: "Sprocket" });
  });

  it("forceDelete() actually removes the row — withTrashed() no longer finds it", async () => {
    await Widget.delete("1");
    await (await Widget.withTrashed().where("id", "1").first())!.forceDelete();

    const rows = await Widget.withTrashed().get();
    expect(rows.length).toBe(1);
    expect(rows.first()).toMatchObject({ name: "Cog" });
  });

  it("delete() (soft delete) fires deleting/deleted, consistent with the base Model.delete()", async () => {
    const fired: string[] = [];
    Widget.on("deleting", (row) => {
      fired.push(`deleting:${(row as any).id}`);
    });
    Widget.on("deleted", (row) => {
      fired.push(`deleted:${(row as any).id}`);
    });

    await Widget.delete("1");

    expect(fired).toEqual(["deleting:1", "deleted:1"]);
  });

  it("forceDelete() fires its own deleting/deleted (it bypasses the base Model.delete())", async () => {
    const fired: string[] = [];
    Widget.on("deleting", (row) => {
      fired.push(`deleting:${(row as any).id}`);
    });
    Widget.on("deleted", (row) => {
      fired.push(`deleted:${(row as any).id}`);
    });

    await (await Widget.find("1"))!.forceDelete();

    expect(fired).toEqual(["deleting:1", "deleted:1"]);
  });

  it("restore() does NOT fire a deleted/deleting event (delete lifecycle only)", async () => {
    await Widget.delete("1");

    let called = false;
    Widget.on("deleting", () => {
      called = true;
    });
    Widget.on("deleted", () => {
      called = true;
    });

    await (await Widget.withTrashed().where("id", "1").first())!.restore();

    expect(called).toBe(false);
  });

  describe("builder delete() / forceDelete() / restore()", () => {
    it("query().where().delete() soft-deletes rather than hard-deleting them", async () => {
      const affected = await Widget.query().where("name", "Sprocket").delete();
      expect(affected).toBe(1);

      // The row is still there, just trashed — the whole point of the
      // model declaring soft deletes.
      const trashed = await Widget.withTrashed().where("id", "1").first();
      expect(trashed).toBeTruthy();
      expect((trashed as any).deleted_at).not.toBeNull();
      expect(await Widget.find("1")).toBeUndefined();
    });

    it("query().delete() over several rows soft-deletes all of them", async () => {
      expect(await Widget.query().delete()).toBe(2);
      expect((await Widget.all()).length).toBe(0);
      expect((await Widget.withTrashed().get()).length).toBe(2);
    });

    it("query().forceDelete() really removes the rows", async () => {
      await Widget.query().where("name", "Sprocket").forceDelete();

      expect((await Widget.withTrashed().get()).length).toBe(1);
    });

    it("onlyTrashed().restore() un-deletes matching rows", async () => {
      await Widget.delete("1");
      await Widget.delete("2");
      expect((await Widget.all()).length).toBe(0);

      const restored = await Widget.onlyTrashed().where("name", "Cog").restore();
      expect(restored).toBe(1);

      const visible = (await Widget.all()).toArray().map((w) => (w as any).name);
      expect(visible).toEqual(["Cog"]);
    });

    it("restore() on a model without soft deletes throws rather than writing a phantom column", async () => {
      class Plain extends Model<WidgetAttributes>()({
        table: "widgets",
        primaryKey: "id",
        timestamps: false,
      }) {}

      await expect(Plain.query().restore()).rejects.toThrow(/does not use soft deletes/);
    });

    it("delete() on a model without soft deletes is still a real DELETE", async () => {
      class Plain extends Model<WidgetAttributes>()({
        table: "widgets",
        primaryKey: "id",
        timestamps: false,
      }) {}

      await Plain.query().where("id", "1").delete();
      expect((await Widget.withTrashed().get()).length).toBe(1);
    });
  });

  describe("persistence bypasses global scopes", () => {
    it("save() on a trashed instance persists", async () => {
      const widget = (await Widget.find("1"))!;
      await Widget.delete("1");

      (widget as any).name = "Renamed";
      await widget.save();

      const reloaded = await Widget.withTrashed().where("id", "1").first();
      expect((reloaded as any).name).toBe("Renamed");
    });

    it("Model.update() on a trashed row persists", async () => {
      await Widget.delete("1");
      await Widget.update("1", { name: "Renamed" });

      const reloaded = await Widget.withTrashed().where("id", "1").first();
      expect((reloaded as any).name).toBe("Renamed");
    });

    it("refresh() works on a trashed instance", async () => {
      const widget = (await Widget.find("1"))!;
      await Widget.delete("1");

      await widget.refresh();
      expect((widget as any).deleted_at).not.toBeNull();
    });
  });

  describe("instance-level trashed() / restore() / forceDelete()", () => {
    it("trashed() reflects whether this instance is soft-deleted", async () => {
      const widget = (await Widget.find("1"))!;
      expect(widget.trashed()).toBe(false);

      await widget.deleteInstance();
      await widget.refresh();
      expect(widget.trashed()).toBe(true);
    });

    it("trashed() is false on a model that doesn't soft-delete", async () => {
      class Plain extends Model<WidgetAttributes>()({
        table: "widgets",
        primaryKey: "id",
        timestamps: false,
      }) {}

      const plain = (await Plain.find("1"))!;
      expect(plain.trashed()).toBe(false);
    });

    it("instance restore() clears deleted_at in the DB and on the instance", async () => {
      await Widget.delete("1");
      const widget = (await Widget.withTrashed().where("id", "1").first())!;
      expect(widget.trashed()).toBe(true);

      await widget.restore();

      expect(widget.trashed()).toBe(false);
      expect(await Widget.find("1")).toBeTruthy();
    });

    it("instance restore() fires restoring/restored with the instance", async () => {
      await Widget.delete("1");
      const widget = (await Widget.withTrashed().where("id", "1").first())!;

      const fired: string[] = [];
      Widget.on("restoring", (row) => {
        fired.push(`restoring:${(row as any).id}`);
      });
      Widget.on("restored", (row) => {
        fired.push(`restored:${(row as any).id}`);
      });

      await widget.restore();
      expect(fired).toEqual(["restoring:1", "restored:1"]);
    });

    it("instance forceDelete() removes the row permanently", async () => {
      const widget = (await Widget.find("1"))!;
      await widget.forceDelete();

      expect((await Widget.withTrashed().get()).length).toBe(1);
      expect(widget.exists()).toBe(false);
    });

    it("instance forceDelete() fires deleting/deleted", async () => {
      const widget = (await Widget.find("1"))!;

      const fired: string[] = [];
      Widget.on("deleting", (row) => {
        fired.push(`deleting:${(row as any).id}`);
      });
      Widget.on("deleted", (row) => {
        fired.push(`deleted:${(row as any).id}`);
      });

      await widget.forceDelete();
      expect(fired).toEqual(["deleting:1", "deleted:1"]);
    });

    it("instance restore() on a non-soft-deleting model throws", async () => {
      class Plain extends Model<WidgetAttributes>()({
        table: "widgets",
        primaryKey: "id",
        timestamps: false,
      }) {}

      const plain = (await Plain.find("1"))!;
      await expect(plain.restore()).rejects.toThrow(/does not use soft deletes/);
    });
  });

  describe("the soft-delete scope is join-safe", () => {
    it("survives a join against another table that also has deleted_at", async () => {
      const kysely = app.make<DatabaseManager>(DATABASE_TOKEN).driver().kysely;
      await kysely.schema
        .createTable("gadgets")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("widget_id", "text", (col) => col.notNull())
        .addColumn("deleted_at", "text")
        .execute();
      await kysely
        .insertInto("gadgets")
        .values([{ id: "g1", widget_id: "1", deleted_at: null }])
        .execute();

      // An unqualified `deleted_at` in the global scope makes this
      // "ambiguous column name" and the query fails outright.
      const rows = await Widget.query()
        .join("gadgets", "gadgets.widget_id", "widgets.id")
        .select("widgets.*")
        .get();

      expect(rows.length).toBe(1);
      expect((rows.first() as any).id).toBe("1");
    });
  });
});
