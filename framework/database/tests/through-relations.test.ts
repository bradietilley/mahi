import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import type { AnyModelClass } from "../src/model.js";
import { hasManyThrough } from "../src/relations.js";
import type { HasManyThrough } from "../src/markers.js";

interface CountryAttributes {
  id: string;
  name: string;
  posts: HasManyThrough<Post>;
}

interface UserAttributes {
  id: string;
  country_id: string;
  name: string;
}

interface PostAttributes {
  id: string;
  user_id: string;
  title: string;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
}) {}

class Country extends Model<CountryAttributes>()({
  table: "countries",
  primaryKey: "id",
  timestamps: false,
}) {
  postsRelation() {
    return this.hasManyThrough(Post as unknown as AnyModelClass, {
      through: () => User,
      firstKey: "country_id",
      secondKey: "user_id",
    });
  }

  static override relationships = {
    posts: hasManyThrough(() => Post, {
      through: () => User,
      firstKey: "country_id",
      secondKey: "user_id",
    }),
  };
}

describe("hasManyThrough / hasOneThrough", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();

    await kysely.schema
      .createTable("countries")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await kysely.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("country_id", "text", (col) => col.notNull())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("user_id", "text", (col) => col.notNull())
      .addColumn("title", "text", (col) => col.notNull())
      .execute();

    await Country.create({ id: "c1", name: "Wonderland" });
    await Country.create({ id: "c2", name: "Oz" });
    await Country.create({ id: "c3", name: "Empty" });

    await User.create({ id: "u1", country_id: "c1", name: "Alice" });
    await User.create({ id: "u2", country_id: "c1", name: "Bob" });
    await User.create({ id: "u3", country_id: "c2", name: "Dorothy" });

    await Post.create({ id: "p1", user_id: "u1", title: "A1" });
    await Post.create({ id: "p2", user_id: "u1", title: "A2" });
    await Post.create({ id: "p3", user_id: "u2", title: "B1" });
    await Post.create({ id: "p4", user_id: "u3", title: "D1" });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("resolves distant related rows through the intermediate model", async () => {
    const country = (await Country.findOrFail("c1")) as Country;
    const posts = await country.postsRelation().get();

    expect(posts.pluck("id").sort().toArray()).toEqual(["p1", "p2", "p3"]);
  });

  it("returns empty when no through rows exist", async () => {
    const country = (await Country.findOrFail("c3")) as Country;
    expect((await country.postsRelation().get()).isEmpty()).toBe(true);
  });

  it("composes with further builder methods", async () => {
    const country = (await Country.findOrFail("c1")) as Country;
    expect(await country.postsRelation().count()).toBe(3);
    expect((await country.postsRelation().where("title", "A1").get()).length).toBe(1);
  });

  it("batch eager-loads through relations across a page", async () => {
    const countries = await Country.query().with("posts").orderBy("id").get();
    const [c1, c2, c3] = countries.toArray();

    expect((c1 as any).posts.pluck("id").sort().toArray()).toEqual(["p1", "p2", "p3"]);
    expect((c2 as any).posts.pluck("id").toArray()).toEqual(["p4"]);
    expect((c3 as any).posts.toArray()).toEqual([]);
  });

  it("withCount and whereHas work through the relation", async () => {
    const withCounts = await Country.query().withCount("posts").orderBy("id").get();
    expect(withCounts.toArray().map((c) => [c.id, (c as any).posts_count])).toEqual([
      ["c1", 3],
      ["c2", 1],
      ["c3", 0],
    ]);

    const having = await Country.query().whereHas("posts").orderBy("id").get();
    expect(having.pluck("id").toArray()).toEqual(["c1", "c2"]);
  });
});
