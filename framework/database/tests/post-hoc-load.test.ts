import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { belongsTo } from "../src/relations.js";
import type { BelongsTo } from "../src/markers.js";

interface AuthorAttributes {
  id: string;
  name: string;
}

interface PostAttributes {
  id: string;
  author_id: string;
  title: string;
  author: BelongsTo<Author>;
}

class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  timestamps: false,
}) {}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
  };
}

describe("instance load() / loadMissing()", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();
    await kysely.schema
      .createTable("authors")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("author_id", "text", (col) => col.notNull())
      .addColumn("title", "text", (col) => col.notNull())
      .execute();

    await Author.create({ id: "a1", name: "Ada" });
    await Author.create({ id: "a2", name: "Grace" });
    await Post.create({ id: "p1", author_id: "a1", title: "First" });
    await Post.create({ id: "p2", author_id: "a2", title: "Second" });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("load() attaches a relation onto an already-fetched instance", async () => {
    const post = await Post.findOrFail("p1");
    expect(post.relationLoaded("author")).toBe(false);

    await post.load("author");
    expect(post.relationLoaded("author")).toBe(true);
    expect((post as any).author?.name).toBe("Ada");
  });

  it("loadMissing() loads a relation that isn't present yet", async () => {
    const post = await Post.findOrFail("p1");
    await post.loadMissing("author");
    expect((post as any).author?.name).toBe("Ada");
  });

  it("loadMissing() skips an already-loaded relation (no re-query)", async () => {
    const post = await Post.query().with("author").where("id", "p1").first();
    // Corrupt the loaded relation so a re-query would be observable
    post!.setRelation("author", { id: "x", name: "STALE" });

    await post!.loadMissing("author");
    expect((post as any).author.name).toBe("STALE");
  });
});
