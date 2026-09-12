import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { EloquentBuilder } from "../src/eloquent-builder.js";
import { belongsToMany, hasMany } from "../src/relations.js";
import type { BelongsToMany, HasMany } from "../src/markers.js";

interface AuthorAttributes {
  id: string;
  name: string;
  posts: HasMany<Post>;
}

interface PostAttributes {
  id: string;
  author_id: string | null;
  title: string;
  approved: number;
  deleted_at: string | null;
  tags: BelongsToMany<Tag>;
}

interface TagAttributes {
  id: string;
  label: string;
}

class Tag extends Model<TagAttributes>()({
  table: "tags",
  primaryKey: "id",
  timestamps: false,
}) {}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
  softDeletes: true,
}) {
  static override relationships = {
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
    }),
  };
}

class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    posts: hasMany(() => Post, { foreignKey: "author_id" }),
  };
}

describe("QueriesRelationships (withCount/whereHas/doesntHave)", () => {
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
      .addColumn("author_id", "text")
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("approved", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("deleted_at", "text")
      .execute();

    await kysely.schema
      .createTable("tags")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("label", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("post_tag")
      .addColumn("post_id", "text", (col) => col.notNull())
      .addColumn("tag_id", "text", (col) => col.notNull())
      .execute();

    await Author.create({ id: "a1", name: "Ada" }); // two posts
    await Author.create({ id: "a2", name: "Grace" }); // one post
    await Author.create({ id: "a3", name: "Nobody" }); // no posts

    await Post.create({ id: "p1", author_id: "a1", title: "First", approved: 1, deleted_at: null });
    await Post.create({
      id: "p2",
      author_id: "a1",
      title: "Second",
      approved: 0,
      deleted_at: null,
    });
    await Post.create({ id: "p3", author_id: "a2", title: "Third", approved: 1, deleted_at: null });

    await Tag.create({ id: "t1", label: "sql" });
    await Tag.create({ id: "t2", label: "typescript" });

    await kysely
      .insertInto("post_tag" as never)
      .values([
        { post_id: "p1", tag_id: "t1" },
        { post_id: "p1", tag_id: "t2" },
      ] as never)
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  describe("withCount()", () => {
    it("adds a {relation}_count column for a hasMany relation", async () => {
      const authors = await Author.query().withCount("posts").orderBy("id").get();

      expect(authors.toArray().map((a) => [a.id, (a as any).posts_count])).toEqual([
        ["a1", 2],
        ["a2", 1],
        ["a3", 0],
      ]);
    });

    it("adds a {relation}_count column for a belongsToMany relation", async () => {
      const posts = await Post.query().withCount("tags").orderBy("id").get();

      expect(posts.toArray().map((p) => [p.id, (p as any).tags_count])).toEqual([
        ["p1", 2],
        ["p2", 0],
        ["p3", 0],
      ]);
    });

    it("respects the related model's global scopes (soft deletes)", async () => {
      await Post.delete("p2"); // soft delete one of Ada's posts
      const authors = await Author.query().withCount("posts").orderBy("id").get();

      expect(authors.toArray().map((a) => (a as any).posts_count)).toEqual([1, 1, 0]);
    });
  });

  describe("whereHas() / has()", () => {
    it("keeps only rows that have at least one related row", async () => {
      const authors = await Author.query().whereHas("posts").orderBy("id").get();

      expect(authors.pluck("id").toArray()).toEqual(["a1", "a2"]);
    });

    it("narrows with a constraining callback", async () => {
      const authors = await Author.query()
        .whereHas("posts", (q) =>
          (q as unknown as EloquentBuilder<PostAttributes>).where("approved", 1),
        )
        .orderBy("id")
        .get();

      expect(authors.pluck("id").toArray()).toEqual(["a1", "a2"]);

      const noneApproved = await Author.query()
        .whereHas("posts", (q) =>
          (q as unknown as EloquentBuilder<PostAttributes>).where("title", "nonexistent"),
        )
        .get();
      expect(noneApproved.isEmpty()).toBe(true);
    });

    it("works for belongsToMany", async () => {
      const posts = await Post.query().whereHas("tags").orderBy("id").get();
      expect(posts.pluck("id").toArray()).toEqual(["p1"]);
    });
  });

  describe("doesntHave() / whereDoesntHave()", () => {
    it("keeps only rows with no related rows", async () => {
      const authors = await Author.query().doesntHave("posts").get();
      expect(authors.pluck("id").toArray()).toEqual(["a3"]);
    });

    it("supports a constraining callback (no approved posts)", async () => {
      const authors = await Author.query()
        .whereDoesntHave("posts", (q) =>
          (q as unknown as EloquentBuilder<PostAttributes>).where("approved", 1),
        )
        .orderBy("id")
        .get();

      // a1 and a2 both have an approved post; a3 has none -> qualifies
      expect(authors.pluck("id").toArray()).toEqual(["a3"]);
    });
  });

  describe("orWhereHas()", () => {
    it("ORs the existence filter with other conditions", async () => {
      const authors = await Author.query()
        .where("name", "Nobody")
        .orWhereHas("posts", (q) =>
          (q as unknown as EloquentBuilder<PostAttributes>).where("approved", 1),
        )
        .orderBy("id")
        .get();

      expect(authors.pluck("id").toArray()).toEqual(["a1", "a2", "a3"]);
    });
  });

  it("throws a clear error for an undeclared relation name", () => {
    expect(() => Author.query().withCount("bogus" as never)).toThrow(/no relation named "bogus"/);
  });
});
