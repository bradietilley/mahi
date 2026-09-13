import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DateTime } from "@mahiframework/datetime";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";

interface PostAttributes {
  id: string;
  body: string;
  published: boolean;
  meta: Record<string, unknown> | null;
  created_at: DateTime | null;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: true,
  casts: {
    published: Cast.boolean(),
    meta: Cast.json<Record<string, unknown>>(),
  },
}) {}

interface UserAttributes {
  id: string;
  name: string;
  password: string;
}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  hidden: ["password"],
}) {}

describe("Model instances", () => {
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
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("meta", "text")
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text")
      .execute();

    await manager
      .driver()
      .kysely.schema.createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("password", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(() => clearCurrentApp());

  it("casts attributes on read (model type) via the proxy", () => {
    const post = Post.hydrate({
      id: "1",
      body: "hi",
      published: 1,
      meta: '{"a":1}',
      created_at: "2026-08-23T00:00:00.000Z",
    });
    expect(post.published).toBe(true);
    expect(post.meta).toEqual({ a: 1 });
    expect(post.created_at).toBeInstanceOf(DateTime);
    expect(post.body).toBe("hi");
  });

  it("casts attributes on write (db type) and tracks dirty", () => {
    const post = Post.hydrate({ id: "1", body: "hi", published: 1, meta: null, created_at: null });
    expect(post.isDirty()).toBe(false);
    post.published = false;
    expect(post.isDirty()).toBe(true);
    expect(post.isDirty("published")).toBe(true);
    expect(post.getDirty()).toEqual({ published: 0 });
    // `getOriginal()` is cast-aware (model shape, matching how the live
    // attribute reads); `getRawOriginal()` is the DB shape `getDirty()`
    // and the persistence path deal in. See model-change-tracking.test.ts.
    expect(post.getOriginal("published")).toBe(true);
    expect(post.getRawOriginal("published")).toBe(1);
  });

  it("new instance casts constructor attributes to db shape", () => {
    const post = new Post({ id: "1", body: "hi", published: true });
    expect(post.getRawAttribute("published")).toBe(1);
    expect(post.published).toBe(true);
    expect(post.exists()).toBe(false);
  });

  it("save() inserts a new instance then updates only dirty columns", async () => {
    const post = new Post({ id: "1", body: "hi", published: true, meta: { a: 1 } });
    await post.save();
    expect(post.exists()).toBe(true);

    const row = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("posts")
      .selectAll()
      .where("id", "=", "1")
      .executeTakeFirst();
    expect(row).toMatchObject({ id: "1", published: 1, meta: '{"a":1}' });
    expect(row!.created_at).toBeTruthy();

    post.body = "updated";
    await post.save();
    const row2 = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("posts")
      .selectAll()
      .where("id", "=", "1")
      .executeTakeFirst();
    expect(row2!.body).toBe("updated");
  });

  it("fill() + updateInstance() persist", async () => {
    const post = new Post({ id: "1", body: "hi", published: false });
    await post.save();
    await post.updateInstance({ published: true, body: "yo" });
    const row = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("posts")
      .selectAll()
      .where("id", "=", "1")
      .executeTakeFirst();
    expect(row!.published).toBe(1);
    expect(row!.body).toBe("yo");
  });

  it("toJSON() emits model-shape values and honors hidden", () => {
    const post = Post.hydrate({
      id: "1",
      body: "hi",
      published: 1,
      meta: '{"a":1}',
      created_at: null,
    });
    const json = post.toJSON();
    expect(json.published).toBe(true);
    expect(json.meta).toEqual({ a: 1 });

    const user = User.hydrate({ id: "1", name: "Sam", password: "secret" });
    expect(user.toJSON()).toEqual({ id: "1", name: "Sam" });
    expect("password" in user.toJSON()).toBe(false);
  });

  it("spread enumerates casted attributes via ownKeys trap", () => {
    const post = Post.hydrate({ id: "1", body: "hi", published: 1, meta: null, created_at: null });
    const spread = { ...post };
    expect(spread.published).toBe(true);
    expect(spread.id).toBe("1");
  });

  it("toObject() returns raw db-shape values", () => {
    const post = Post.hydrate({ id: "1", body: "hi", published: 1, meta: null, created_at: null });
    expect(post.toObject().published).toBe(1);
  });

  it("enumeration omits appended values, which a direct read and toJSON() still see", () => {
    // `ownKeys` lists the model's real columns (`toObject()`), so an
    // appended value is reachable directly and through `toJSON()` but is
    // NOT enumerable. Pinned because the docs described this section
    // wrongly for a while, claiming spread yielded *raw* values, when
    // in fact `getOwnPropertyDescriptor` casts and the real gap is
    // relations/appends.
    const post = Post.hydrate({ id: "1", body: "hi", published: 1, meta: null, created_at: null });
    post.setAppended("excerpt", "hi…");

    expect((post as unknown as { excerpt: string }).excerpt).toBe("hi…");
    expect(Object.keys(post)).not.toContain("excerpt");
    expect({ ...post }).not.toHaveProperty("excerpt");
  });

  it("refresh() re-reads and resets dirty tracking", async () => {
    const post = new Post({ id: "1", body: "hi", published: false });
    await post.save();
    post.body = "local change";
    await post.refresh();
    expect(post.body).toBe("hi");
    expect(post.isDirty()).toBe(false);
  });

  it("replicate() strips the primary key and is unsaved", () => {
    const post = Post.hydrate({ id: "1", body: "hi", published: 1, meta: null, created_at: "x" });
    const copy = post.replicate();
    expect(copy.getRawAttribute("id")).toBeUndefined();
    expect(copy.exists()).toBe(false);
    expect(copy.body).toBe("hi");
  });

  it("find()/first() return hydrated instances", async () => {
    await new Post({ id: "1", body: "hi", published: true }).save();
    const found = await Post.find("1");
    expect(found).toBeInstanceOf(Post);
    expect(found!.published).toBe(true);
    expect(found!.isDirty()).toBe(false);

    const first = await Post.query().where("id", "1").first();
    expect(first).toBeInstanceOf(Post);
  });

  it("delete() removes the row via the instance", async () => {
    const post = await new Post({ id: "1", body: "hi", published: false }).save();
    await post.deleteInstance();
    expect(await Post.find("1")).toBeUndefined();
  });

  it("JSON.stringify serializes model-shape values and hides hidden", () => {
    const user = User.hydrate({ id: "1", name: "Sam", password: "secret" });
    expect(JSON.parse(JSON.stringify(user))).toEqual({ id: "1", name: "Sam" });
  });

  // The instance proxy binds methods so their private-field access works
  // through the proxy the caller holds. A *class constructor* must be
  // exempted: `bind()` returns a wrapper that is not the class and
  // carries none of its statics, so `post.constructor.table` read
  // `undefined` and every `this.constructor as typeof Model` on a
  // proxied instance silently addressed the wrong class.
  it("constructor read through the proxy is the real class, with its statics", async () => {
    const post = await new Post({ id: "1", body: "hi", published: false }).save();

    expect(post.constructor).toBe(Post);
    expect((post.constructor as typeof Post).table).toBe("posts");
    expect((post.constructor as typeof Post).primaryKeyColumn).toBe("id");
  });

  it("methods read through the proxy are still bound to the target", async () => {
    const post = await new Post({ id: "1", body: "hi", published: false }).save();

    // Detached from the instance: only a bound method still works.
    const { toObject } = post;
    expect(toObject()).toMatchObject({ id: "1", body: "hi" });
  });
});
