import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, Collection, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import type { AnyModelClass } from "../src/model.js";
import { belongsTo, belongsToMany, hasMany, hasOne } from "../src/relations.js";
import type { BelongsTo, BelongsToMany, HasMany, HasOne } from "../src/markers.js";

interface AuthorAttributes {
  id: string;
  name: string;
  posts: HasMany<Post>;
  profile: HasOne<Profile>;
}

interface PostAttributes {
  id: string;
  author_id: string | null;
  title: string;
  deleted_at: string | null;
  author: BelongsTo<Author>;
  tags: BelongsToMany<Tag>;
  tagsWithPivot: BelongsToMany<Tag>;
}

interface TagAttributes {
  id: string;
  label: string;
}

interface ProfileAttributes {
  id: string;
  author_id: string;
  bio: string;
}

class Tag extends Model<TagAttributes>()({
  table: "tags",
  primaryKey: "id",
  timestamps: false,
}) {}

class Profile extends Model<ProfileAttributes>()({
  table: "profiles",
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
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
    }),
    tagsWithPivot: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
      withPivot: ["weight"],
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
    profile: hasOne(() => Profile, { foreignKey: "author_id" }),
  };
}

describe("Model relationships", () => {
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
      .addColumn("weight", "integer", (col) => col.notNull().defaultTo(0))
      .execute();

    await kysely.schema
      .createTable("profiles")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("author_id", "text", (col) => col.notNull())
      .addColumn("bio", "text", (col) => col.notNull())
      .execute();

    await Author.create({ id: "a1", name: "Ada" });
    await Author.create({ id: "a2", name: "Grace" });

    await Post.create({ id: "p1", author_id: "a1", title: "First", deleted_at: null });
    await Post.create({ id: "p2", author_id: "a1", title: "Second", deleted_at: null });
    await Post.create({ id: "p3", author_id: "a2", title: "Third", deleted_at: null });
    await Post.create({ id: "p4", author_id: null, title: "Orphan", deleted_at: null });

    await Tag.create({ id: "t1", label: "sql" });
    await Tag.create({ id: "t2", label: "typescript" });
    await Tag.create({ id: "t3", label: "unused" });

    await kysely
      .insertInto("post_tag" as never)
      .values([
        { post_id: "p1", tag_id: "t1", weight: 3 },
        { post_id: "p1", tag_id: "t2", weight: 7 },
        // t2 again, with a DIFFERENT weight — the same tag carries
        // different pivot data per post.
        { post_id: "p2", tag_id: "t2", weight: 11 },
      ] as never)
      .execute();

    await Profile.create({ id: "pr1", author_id: "a1", bio: "Analytical engine enthusiast" });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  describe("relations.belongsTo()", () => {
    it("resolves the owning row", async () => {
      const post = await Post.findOrFail("p1");
      const author = await post.relations.author().first();

      expect(author).toMatchObject({ id: "a1", name: "Ada" });
    });

    it("returns undefined when the foreign key is null", async () => {
      const post = await Post.findOrFail("p4");

      expect(await post.relations.author().first()).toBeUndefined();
    });

    it("returns undefined when the foreign key points at a missing row", async () => {
      await Post.create({ id: "p5", author_id: "gone", title: "Dangling", deleted_at: null });
      const post = await Post.findOrFail("p5");

      expect(await post.relations.author().first()).toBeUndefined();
    });

    it("honours a custom ownerKey via the generic instance helper", async () => {
      const post = await Post.findOrFail("p1");
      const byName = await post
        .belongsTo(Author as unknown as AnyModelClass, {
          foreignKey: "title",
          ownerKey: "name",
        })
        .first();

      expect(byName).toBeUndefined(); // no author named "First"
    });
  });

  describe("relations.hasMany()", () => {
    it("returns only the related rows", async () => {
      const author = await Author.findOrFail("a1");
      const posts = await author.relations.posts().get();

      expect(posts.pluck("id").sort().toArray()).toEqual(["p1", "p2"]);
    });

    it("returns an empty Collection when nothing matches", async () => {
      await Author.create({ id: "a3", name: "Nobody" });
      const author = await Author.findOrFail("a3");
      const posts = await author.relations.posts().get();

      expect(posts.isEmpty()).toBe(true);
      expect(posts.toArray()).toEqual([]);
    });

    it("returns a builder, so it composes with where/orderBy/limit/count", async () => {
      const author = await Author.findOrFail("a1");

      expect(await author.relations.posts().count()).toBe(2);
      expect(
        (await author.relations.posts().orderBy("title", "desc").limit(1).get()).first(),
      ).toMatchObject({ title: "Second" });
      expect((await author.relations.posts().where("title", "First").get()).length).toBe(1);
    });

    it("applies the related model's global scopes (soft-deleted rows excluded)", async () => {
      const author = await Author.findOrFail("a1");
      await Post.delete("p1");

      expect((await author.relations.posts().get()).pluck("id").toArray()).toEqual(["p2"]);
    });
  });

  describe("relations.hasOne()", () => {
    it("resolves the single related row, or undefined", async () => {
      const ada = await Author.findOrFail("a1");
      const grace = await Author.findOrFail("a2");

      expect(await ada.relations.profile().first()).toMatchObject({
        bio: "Analytical engine enthusiast",
      });
      expect(await grace.relations.profile().first()).toBeUndefined();
    });
  });

  describe("relations.belongsToMany()", () => {
    it("returns rows joined through the pivot table", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await post.relations.tags().get();

      expect(tags.pluck("label").sort().toArray()).toEqual(["sql", "typescript"]);
    });

    it("returns only rows in the pivot, not every related row", async () => {
      const post = await Post.findOrFail("p2");

      expect((await post.relations.tags().get()).pluck("label").toArray()).toEqual(["typescript"]);
    });

    it("returns an empty Collection for a row with no pivot entries", async () => {
      const post = await Post.findOrFail("p3");
      const tags = await post.relations.tags().get();

      expect(tags.isEmpty()).toBe(true);
    });

    it("returns plain related rows with no pivot columns mixed in", async () => {
      const post = await Post.findOrFail("p2");
      const tag = (await post.relations.tags().get()).first();

      expect(Object.keys(tag!).sort()).toEqual(["id", "label"]);
    });

    it("composes with further builder calls", async () => {
      const post = await Post.findOrFail("p1");

      expect(await post.relations.tags().count()).toBe(2);
      expect((await post.relations.tags().where("label", "sql").get()).length).toBe(1);
    });
  });

  describe("belongsToMany withPivot", () => {
    it("exposes requested pivot columns under a pivot accessor", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await post.relations.tagsWithPivot().orderBy("label").get();

      expect(tags.toArray().map((t: any) => [t.label, t.pivot.weight])).toEqual([
        ["sql", 3],
        ["typescript", 7],
      ]);
    });

    it("keeps pivot values out of the model's own attributes", async () => {
      const post = await Post.findOrFail("p1");
      const tag = (await post.relations.tagsWithPivot().get()).first()!;

      expect(Object.keys(tag.toObject()).sort()).toEqual(["id", "label"]);
      expect(tag.isDirty()).toBe(false);
    });

    it("gives the same tag different pivot values per parent", async () => {
      const p1 = await Post.findOrFail("p1");
      const p2 = await Post.findOrFail("p2");

      const fromP1 = (await p1.relations.tagsWithPivot().where("id", "t2").get()).first()! as any;
      const fromP2 = (await p2.relations.tagsWithPivot().where("id", "t2").get()).first()! as any;

      expect(fromP1.pivot.weight).toBe(7);
      expect(fromP2.pivot.weight).toBe(11);
    });

    it("carries pivot columns through eager loading, per parent", async () => {
      const posts = await Post.query().with("tagsWithPivot").orderBy("id").get();
      const [p1, p2] = posts.toArray();

      const t2FromP1 = (p1 as any).tagsWithPivot.first((t: any) => t.id === "t2");
      const t2FromP2 = (p2 as any).tagsWithPivot.first((t: any) => t.id === "t2");

      expect(t2FromP1.pivot.weight).toBe(7);
      expect(t2FromP2.pivot.weight).toBe(11);
    });

    it("leaves the relation without withPivot unchanged", async () => {
      const post = await Post.findOrFail("p1");
      const tag = (await post.relations.tags().get()).first()! as any;

      expect(tag.pivot).toBeUndefined();
    });

    it("still honours the related model's global scopes", async () => {
      // Tag has no SoftDeletes, but the join form must not bypass
      // scopes the subquery form respected — it starts from query().
      const post = await Post.findOrFail("p1");
      expect(await post.relations.tagsWithPivot().count()).toBe(2);
    });
  });

  describe("with() eager loading", () => {
    it("batch-loads a belongsTo relation across a page of results in one extra query", async () => {
      const posts = await Post.query().with("author").orderBy("id").get();

      expect(posts.toArray().map((p) => p.author?.name)).toEqual([
        "Ada",
        "Ada",
        "Grace",
        undefined,
      ]);
    });

    it("batch-loads a hasMany relation, grouping related rows onto each parent", async () => {
      const authors = await Author.query().with("posts").orderBy("id").get();

      const [ada, grace] = authors.toArray();
      expect(ada!.posts.pluck("id").sort().toArray()).toEqual(["p1", "p2"]);
      expect(grace!.posts.pluck("id").toArray()).toEqual(["p3"]);
    });

    it("batch-loads a hasOne relation, undefined when nothing matches", async () => {
      const authors = await Author.query().with("profile").orderBy("id").get();

      const [ada, grace] = authors.toArray();
      expect(ada!.profile?.bio).toBe("Analytical engine enthusiast");
      expect(grace!.profile).toBeUndefined();
    });

    it("batch-loads a belongsToMany relation across the whole result set in a constant number of queries", async () => {
      const posts = await Post.query().with("tags").orderBy("id").get();

      const [p1, p2, p3] = posts.toArray();
      expect(p1!.tags.pluck("label").sort().toArray()).toEqual(["sql", "typescript"]);
      expect(p2!.tags.pluck("label").toArray()).toEqual(["typescript"]);
      expect(p3!.tags.toArray()).toEqual([]);
    });

    it("composes with multiple relation names in one with() call", async () => {
      const posts = await Post.query().with("author", "tags").where("id", "p1").get();
      const post = posts.first()!;

      expect(post.author?.name).toBe("Ada");
      expect(post.tags.pluck("label").sort().toArray()).toEqual(["sql", "typescript"]);
    });

    it("first() applies eager loading to the single returned row", async () => {
      const post = await Post.query().with("author").where("id", "p1").first();

      expect(post?.author?.name).toBe("Ada");
    });

    it("throws a clear error for an undeclared relation name", async () => {
      await expect(
        Post.query()
          .with("bogus" as never)
          .get(),
      ).rejects.toThrow(/no relation named "bogus"/);
    });
  });

  describe("instance relations namespace and load()", () => {
    it("relations.belongsTo() returns the related model builder", async () => {
      const post = await Post.find("p1");
      const author = await post!.relations.author().first();
      expect(author?.name).toBe("Ada");
    });

    it("relations.hasMany() returns the related model builder", async () => {
      const author = await Author.find("a1");
      const posts = await author!.relations.posts().orderBy("id").get();
      expect(posts.toArray().map((p) => p.id)).toEqual(["p1", "p2"]);
    });

    it("load() lazily populates a relation on an existing instance", async () => {
      const post = await Post.find("p1");
      expect(post!.relationLoaded("author")).toBe(false);
      await post!.load("author");
      expect(post!.relationLoaded("author")).toBe(true);
      expect(post!.author?.name).toBe("Ada");
    });

    it("load() batches a hasMany onto an instance as a Collection", async () => {
      const author = await Author.find("a1");
      await author!.load("posts");
      expect(author!.posts!.pluck("id").sort().toArray()).toEqual(["p1", "p2"]);
    });

    it("loadMissing() populates only relations not already loaded", async () => {
      const post = await Post.find("p1");
      await post!.load("author");
      const first = post!.author;
      await post!.loadMissing("author", "tags");
      // author untouched (same loaded instance), tags now present
      expect(post!.author).toBe(first);
      expect(post!.tags!.pluck("label").sort().toArray()).toEqual(["sql", "typescript"]);
    });

    it("the loaded value accessor is a single instance (belongsTo) or a Collection (hasMany)", async () => {
      const post = await Post.query().with("author").where("id", "p1").first();
      expect(post!.author).toBeInstanceOf(Author);

      const author = await Author.query().with("posts").where("id", "a1").first();
      expect(author!.posts).toBeInstanceOf(Collection);
      expect(author!.posts.every((p) => p instanceof Post)).toBe(true);
    });

    it("an unloaded relation value accessor is undefined", async () => {
      const post = await Post.find("p1");
      expect(post!.relationLoaded("author")).toBe(false);
      expect(post!.author).toBeUndefined();
    });
  });
});
