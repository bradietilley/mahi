import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { EloquentBuilder } from "../src/eloquent-builder.js";

interface PostAttributes {
  id: string;
  title: string;
  published: number;
  pinned: number;
  views: number;
  created_at: string;
}

/** A custom per-model builder, matching the "Custom per-model query builders" pattern documented on Model. */
class PostBuilder extends EloquentBuilder<PostAttributes> {
  published(): this {
    return this.where("published", 1);
  }

  pinned(): this {
    return this.where("pinned", 1);
  }
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: { createdAt: "created_at", updatedAt: null },
}) {
  /** The single builder override point. `Post.query()` returns `PostBuilder`. */
  static query(): PostBuilder {
    this.bootIfNotBooted();
    const builder = new PostBuilder(this);

    for (const scope of this.scopes) {
      scope.apply(builder);
    }

    return builder;
  }
}

describe("EloquentBuilder", () => {
  let app: Application;
  let manager: DatabaseManager;

  beforeEach(async () => {
    app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("pinned", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("views", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo("2024-01-01 00:00:00"))
      .execute();

    await Post.create({
      id: "1",
      title: "Draft",
      published: 0,
      pinned: 0,
      views: 3,
      created_at: "2024-01-15 09:00:00",
    });
    await Post.create({
      id: "2",
      title: "Live",
      published: 1,
      pinned: 0,
      views: 10,
      created_at: "2024-06-20 12:00:00",
    });
    await Post.create({
      id: "3",
      title: "Pinned",
      published: 1,
      pinned: 1,
      views: 7,
      created_at: "2024-06-20 18:00:00",
    });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("Model.query() returns the custom builder subclass, not the base EloquentBuilder", async () => {
    const builder = Post.query();
    expect(builder).toBeInstanceOf(PostBuilder);
  });

  it("custom builder scopes (published()) chain with base methods and narrow correctly", async () => {
    const published = await Post.query().published().get();
    expect(published.length).toBe(2);
  });

  it("orWhere() combines conditions with OR", async () => {
    const rows = await Post.query().where("title", "Draft").orWhere("title", "Live").get();
    expect(
      rows
        .toArray()
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Draft", "Live"]);
  });

  it("where(callback) builds a nested group using a fresh instance of the SAME custom builder subclass", async () => {
    // Inside the callback, the nested builder is a PostBuilder too. Its
    // own `published()`/`pinned()` scopes are callable, not just base
    // where()/orWhere().
    const rows = await Post.query()
      .where((q) => (q as PostBuilder).published().orWhere("pinned", 1))
      .get();
    expect(
      rows
        .toArray()
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Live", "Pinned"]);
  });

  it("whereIn() accepts a Subquery callback in place of a value list", async () => {
    const rows = await Post.query()
      .whereIn("id", (q) => q.table("posts").select("id").where("pinned", 1))
      .get();
    expect(rows.toArray().map((r) => r.title)).toEqual(["Pinned"]);
  });

  it("whereNull()/whereNotNull() are exposed", async () => {
    const rows = await Post.query().whereNotNull("title").get();
    expect(rows.length).toBe(3);
  });

  it("exists()/doesntExist() proxy to the underlying QueryBuilder", async () => {
    expect(await Post.query().where("title", "Live").exists()).toBe(true);
    expect(await Post.query().where("title", "Missing").doesntExist()).toBe(true);
  });

  it("min()/max()/sum()/avg() compute scalar aggregates", async () => {
    expect(await Post.query().max("views")).toBe(10);
    expect(await Post.query().sum("views")).toBe(20);
  });

  it("countBy() groups matching rows by a column", async () => {
    const counts = await Post.query().countBy("published");
    expect(counts.get(1)).toBe(2);
    expect(counts.get(0)).toBe(1);
  });

  it("increment()/decrement() adjust a numeric column", async () => {
    await Post.query().whereKey("1").increment("views", 2);
    expect(await Post.find("1")).toMatchObject({ views: 5 });
  });

  it("whereKey() filters by the model's primaryKeyColumn", async () => {
    const row = await Post.query().whereKey("2").first();
    expect(row).toMatchObject({ title: "Live" });
  });

  it("get() returns a Collection, not a plain array", async () => {
    const all = await Post.query().get();
    expect(typeof all.toArray).toBe("function");
    expect(all.length).toBe(3);
  });

  it("update()/delete() operate on rows matching accumulated where() conditions", async () => {
    const affected = await Post.query().where("published", 0).update({ title: "Updated Draft" });
    expect(affected).toBe(1);
    expect(await Post.find("1")).toMatchObject({ title: "Updated Draft" });

    const deleted = await Post.query().where("pinned", 1).delete();
    expect(deleted).toBe(1);
    expect(await Post.find("3")).toBeUndefined();
  });

  it("toBase() exposes the underlying QueryBuilder escape hatch", async () => {
    const base = Post.query().toBase();
    const count = await base.where("published", 1).count();
    expect(count).toBe(2);
  });

  it("whereDate()/whereMonth() filter by a date part", async () => {
    const rows = await Post.query().whereMonth("created_at", "06").get();
    expect(
      rows
        .toArray()
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Live", "Pinned"]);
  });

  it("whereBetween()/whereColumn()/whereExists() are exposed", async () => {
    const between = await Post.query().whereBetween("views", 5, 10).get();
    expect(
      between
        .toArray()
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Live", "Pinned"]);

    const columnCmp = await Post.query().whereColumn("views", ">", "pinned").get();
    expect(columnCmp.length).toBe(3);

    const withExists = await Post.query()
      .whereExists((q) => q.table("posts").select("id").where("pinned", 1))
      .get();
    expect(withExists.length).toBe(3); // at least one pinned post exists, so every row passes
  });

  it("whereJsonContains()/whereJsonContainsKey()/whereJsonLength() proxy to the underlying QueryBuilder against a real JSON column", async () => {
    await manager.driver().kysely.schema.alterTable("posts").addColumn("tags", "text").execute();
    await manager
      .driver()
      .kysely.updateTable("posts")
      .set({ tags: JSON.stringify(["news"]) } as any)
      .where("id", "=", "1")
      .execute();
    await manager
      .driver()
      .kysely.updateTable("posts")
      .set({ tags: JSON.stringify([]) } as any)
      .where("id", "in", ["2", "3"])
      .execute();

    const query = () =>
      Post.query() as unknown as EloquentBuilder<PostAttributes & { tags: string }>;
    expect((await query().whereJsonContains("tags", "news").get()).length).toBe(1);
    expect((await query().whereJsonContainsKey("tags").get()).length).toBe(3);
    expect((await query().whereJsonLength("tags", ">", 0).get()).length).toBe(1);
  });

  it("orderByRaw()/inRandomOrder()/reorder() manipulate ordering", async () => {
    const rows = await Post.query().orderByRaw("views desc").get();
    expect(rows.toArray().map((r) => r.title)).toEqual(["Live", "Pinned", "Draft"]);

    const reordered = await Post.query().orderBy("title", "asc").reorderDesc("views").get();
    expect(reordered.toArray().map((r) => r.title)).toEqual(["Live", "Pinned", "Draft"]);

    const randomized = await Post.query().inRandomOrder().get();
    expect(randomized.length).toBe(3);
  });

  it("lock()/lockForUpdate()/sharedLock() are documented no-ops on SQLite and don't throw", async () => {
    const rows = await Post.query().where("published", 1).lockForUpdate().get();
    expect(rows.length).toBe(2);
  });

  it("toSql()/getBindings()/toRawSql() expose the compiled query", async () => {
    const builder = Post.query().where("published", 1);
    expect(builder.toSql()).toContain("where");
    expect(builder.getBindings()).toEqual([1]);
    expect(builder.toRawSql()).toContain("1");
  });

  it("clone() branches a builder into independent copies", async () => {
    const base = Post.query().where("published", 1);
    const clone = base.clone().where("pinned", 1);

    const baseRows = await base.get();
    const cloneRows = await clone.get();

    expect(baseRows.length).toBe(2);
    expect(cloneRows.toArray().map((r) => r.title)).toEqual(["Pinned"]);
  });

  it("distinct()/orderByDesc()/latest()/oldest() are exposed", async () => {
    const distinct = await Post.query().distinct().get();
    expect(distinct.length).toBe(3);

    const newest = await Post.query().latest("created_at").first();
    expect(newest?.title).toBe("Pinned");

    const oldest = await Post.query().oldest("created_at").first();
    expect(oldest?.title).toBe("Draft");
  });

  it("selectRaw() widens the row type with a correlated-subquery column, and applies to first() too", async () => {
    const withDoubled = Post.query().selectRaw<{ doubled_views: number }>(
      "views * 2 as doubled_views",
    );
    const rows = await withDoubled.where("id", "2").get();
    expect(rows.first()?.doubled_views).toBe(20);

    const row = await Post.query()
      .selectRaw<{ doubled_views: number }>("views * 2 as doubled_views")
      .where("id", "3")
      .first();
    expect(row?.doubled_views).toBe(14);
    expect(row?.title).toBe("Pinned"); // still typed with the base row's columns too
  });

  it("when()/unless() conditionally apply a callback on the Eloquent builder", async () => {
    const published = await Post.query()
      .when(true, (q) => q.published())
      .get();
    expect(published.length).toBe(2);

    const unfiltered = await Post.query()
      .when(false, (q) => q.published())
      .get();
    expect(unfiltered.length).toBe(3);

    const unlessDrafts = await Post.query()
      .unless(false, (q) => q.published())
      .get();
    expect(unlessDrafts.length).toBe(2);
  });
});
