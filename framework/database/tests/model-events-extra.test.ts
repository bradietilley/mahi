import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";

interface PostAttributes {
  id: string;
  title: string;
  deleted_at: string | null;
}
type PostTable = PostAttributes;

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
  softDeletes: true,
}) {}

describe("retrieved / restoring / restored events", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("deleted_at", "text")
      .execute();

    await Post.create({ id: "p1", title: "First", deleted_at: null });
    await Post.create({ id: "p2", title: "Second", deleted_at: null });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("fires retrieved for each hydrated instance on get()", async () => {
    const seen: string[] = [];
    Post.on("retrieved", (row) => {
      seen.push((row as PostTable).id);
    });

    await Post.query().orderBy("id").get();
    expect(seen).toEqual(["p1", "p2"]);
  });

  it("fires retrieved on first()/find()", async () => {
    const seen: string[] = [];
    Post.on("retrieved", (row) => {
      seen.push((row as PostTable).id);
    });

    await Post.find("p1");
    expect(seen).toEqual(["p1"]);
  });

  it("does not fire retrieved when nothing matches", async () => {
    const seen: string[] = [];
    Post.on("retrieved", (row) => {
      seen.push((row as PostTable).id);
    });

    await Post.query().where("id", "missing").first();
    expect(seen).toEqual([]);
  });

  it("fires restoring then restored on SoftDeletes.restore()", async () => {
    const order: string[] = [];
    Post.on("restoring", () => {
      order.push("restoring");
    });
    Post.on("restored", () => {
      order.push("restored");
    });

    await Post.delete("p1");
    const trashed = await Post.withTrashed().where("id", "p1").first();
    await (trashed as any).restore();

    expect(order).toEqual(["restoring", "restored"]);
    // row is visible again
    expect(await Post.find("p1")).toBeTruthy();
  });
});
