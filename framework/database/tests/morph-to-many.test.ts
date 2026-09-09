import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Relation } from "../src/morph-map.js";
import { morphToMany, morphedByMany } from "../src/relations.js";
import type { MorphToMany, MorphedByMany } from "../src/markers.js";

interface TagAttributes {
  id: string;
  name: string;
  posts: MorphedByMany<Post>;
  videos: MorphedByMany<Video>;
  postsWithPivot: MorphedByMany<Post>;
}

interface PostAttributes {
  id: string;
  title: string;
  tags: MorphToMany<Tag>;
  tagsWithPivot: MorphToMany<Tag>;
  tagsWithTimestamps: MorphToMany<Tag>;
  defaultedTags: MorphToMany<Tag>;
}

interface VideoAttributes {
  id: string;
  url: string;
  tags: MorphToMany<Tag>;
}

/**
 * One `taggables` pivot shared by posts and videos — the canonical
 * polymorphic many-to-many. `Post.tags`/`Video.tags` read it as
 * `morphToMany`; `Tag.posts`/`Tag.videos` read the SAME pivot back as
 * `morphedByMany`.
 */
class Tag extends Model<TagAttributes>()({
  table: "tags",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    posts: morphedByMany(() => Post, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      foreignPivotKey: "tag_id",
      type: "post",
    }),
    videos: morphedByMany(() => Video, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      foreignPivotKey: "tag_id",
      type: "video",
    }),
    postsWithPivot: morphedByMany(() => Post, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      foreignPivotKey: "tag_id",
      type: "post",
      withPivot: ["weight"],
    }),
  };
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    tags: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
      type: "post",
    }),
    tagsWithPivot: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
      type: "post",
      withPivot: ["weight"],
    }),
    tagsWithTimestamps: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
      type: "post",
      withTimestamps: true,
    }),
    /** No explicit `type` — defaults to this model's morphAlias(). */
    defaultedTags: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
    }),
  };
}

class Video extends Model<VideoAttributes>()({
  table: "videos",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    tags: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
      type: "video",
    }),
  };
}

describe("Polymorphic many-to-many", () => {
  let app: Application;
  let selectLog: string[] = [];

  const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
    selectLog = [];
    await fn();

    return selectLog.length;
  };

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => {
      const driver = new SqliteDriver({ filename: ":memory:" });
      const executor = (driver.kysely as any).getExecutor();
      const original = executor.executeQuery.bind(executor);
      executor.executeQuery = (compiled: any, ...rest: any[]) => {
        const sql = compiled?.query ? compiled.sql : compiled?.sql;

        if (typeof sql === "string" && sql.trimStart().toLowerCase().startsWith("select")) {
          selectLog.push(sql);
        }

        return original(compiled, ...rest);
      };

      return driver;
    });
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();

    await kysely.schema
      .createTable("tags")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("videos")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("url", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("taggables")
      .addColumn("tag_id", "text", (col) => col.notNull())
      .addColumn("taggable_id", "text", (col) => col.notNull())
      .addColumn("taggable_type", "text", (col) => col.notNull())
      .addColumn("weight", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text")
      .execute();

    await Tag.create({ id: "t-rel", name: "release" });
    await Tag.create({ id: "t-news", name: "news" });
    await Tag.create({ id: "t-old", name: "unused" });

    await Post.create({ id: "p1", title: "First post" });
    await Post.create({ id: "p2", title: "Second post" });
    await Video.create({ id: "v1", url: "http://example.com/v1" });

    // p1 -> release(5), news(1);  p2 -> release(9);  v1 -> release(2)
    // Note v1 and p1 BOTH link tag t-rel — the discriminant is the only
    // thing separating them.
    await kysely
      .insertInto("taggables")
      .values([
        {
          tag_id: "t-rel",
          taggable_id: "p1",
          taggable_type: "post",
          weight: 5,
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
        },
        {
          tag_id: "t-news",
          taggable_id: "p1",
          taggable_type: "post",
          weight: 1,
          created_at: "2024-01-03",
          updated_at: "2024-01-04",
        },
        {
          tag_id: "t-rel",
          taggable_id: "p2",
          taggable_type: "post",
          weight: 9,
          created_at: "2024-01-05",
          updated_at: "2024-01-06",
        },
        {
          tag_id: "t-rel",
          taggable_id: "v1",
          taggable_type: "video",
          weight: 2,
          created_at: "2024-01-07",
          updated_at: "2024-01-08",
        },
      ])
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  describe("morphToMany (the morphed side)", () => {
    it("returns only this post's tags", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await (post as any).relations.tags().get();

      expect(tags.pluck("name").sort().toArray()).toEqual(["news", "release"]);
    });

    it("scopes by the pivot discriminant, not just the id", async () => {
      // v1 and p1 share id-space in the pivot only via taggable_type.
      const video = await Video.findOrFail("v1");
      const tags = await (video as any).relations.tags().get();

      expect(tags.pluck("name").toArray()).toEqual(["release"]);
    });

    it("does not leak a video's tags into a post with the same id", async () => {
      await Post.create({ id: "shared", title: "Post shared" });
      await Video.create({ id: "shared", url: "video-shared" });
      const { kysely } = app.make<DatabaseManager>(DATABASE_TOKEN).driver();
      await kysely
        .insertInto("taggables")
        .values([
          { tag_id: "t-news", taggable_id: "shared", taggable_type: "post", weight: 0 },
          { tag_id: "t-rel", taggable_id: "shared", taggable_type: "video", weight: 0 },
        ])
        .execute();

      const post = await Post.findOrFail("shared");
      const video = await Video.findOrFail("shared");

      expect((await (post as any).relations.tags().get()).pluck("name").toArray()).toEqual([
        "news",
      ]);
      expect((await (video as any).relations.tags().get()).pluck("name").toArray()).toEqual([
        "release",
      ]);
    });

    it("returns empty for a parent with no links", async () => {
      const post = await Post.create({ id: "p9", title: "Untagged" });
      expect((await (post as any).relations.tags().get()).isEmpty()).toBe(true);
    });

    it("defaults the discriminant to the declaring model's morphAlias()", async () => {
      // Unmapped, Post.morphAlias() is "posts" (the table) — which no
      // pivot row stores, so nothing matches.
      const post = await Post.findOrFail("p1");
      expect((await (post as any).relations.defaultedTags().get()).isEmpty()).toBe(true);

      // Mapping it to what the rows actually store fixes it.
      Relation.morphMap({ post: () => Post });
      const remapped = await Post.findOrFail("p1");
      expect((await (remapped as any).relations.defaultedTags().get()).count()).toBe(2);
    });
  });

  describe("morphedByMany (the inverse side)", () => {
    it("reads the same pivot back the other way", async () => {
      const tag = await Tag.findOrFail("t-rel");
      const posts = await (tag as any).relations.posts().get();

      expect(posts.pluck("id").sort().toArray()).toEqual(["p1", "p2"]);
    });

    it("filters by the RELATED model's discriminant", async () => {
      // The same tag, same pivot — only `type` differs between these two.
      const tag = await Tag.findOrFail("t-rel");

      expect((await (tag as any).relations.posts().get()).count()).toBe(2);
      expect((await (tag as any).relations.videos().get()).pluck("id").toArray()).toEqual(["v1"]);
    });

    it("returns empty for a tag linked to nothing", async () => {
      const tag = await Tag.findOrFail("t-old");
      expect((await (tag as any).relations.posts().get()).isEmpty()).toBe(true);
    });

    it("round-trips: a post's tag lists that post back", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await (post as any).relations.tags().get();
      const tag = await Tag.findOrFail(tags.first()!.id);
      const posts = await (tag as any).relations.posts().get();

      expect(posts.pluck("id").toArray()).toContain("p1");
    });
  });

  describe("withPivot", () => {
    it("exposes requested pivot columns under a pivot accessor", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await (post as any).relations.tagsWithPivot().orderBy("name").get();

      expect(tags.toArray().map((t: any) => [t.name, t.pivot.weight])).toEqual([
        ["news", 1],
        ["release", 5],
      ]);
    });

    it("keeps pivot values off the model's own attributes", async () => {
      const post = await Post.findOrFail("p1");
      const tag = (await (post as any).relations.tagsWithPivot().get()).first()!;

      // The pivot is readable, but is not a column of `tags` — so it must
      // not appear in the row object or be dirty-trackable.
      expect(tag.pivot.weight).toBeDefined();
      expect(Object.keys(tag.toObject())).toEqual(["id", "name"]);
      expect(tag.toObject().pivot__weight).toBeUndefined();
      expect(tag.isDirty()).toBe(false);
    });

    it("gives the same tag different pivot values per parent", async () => {
      // t-rel is weight 5 on p1 and weight 9 on p2. A shared instance
      // would show one of them the other's data.
      const p1 = await Post.findOrFail("p1");
      const p2 = await Post.findOrFail("p2");

      const fromP1 = (
        await (p1 as any).relations.tagsWithPivot().where("id", "t-rel").get()
      ).first()!;
      const fromP2 = (
        await (p2 as any).relations.tagsWithPivot().where("id", "t-rel").get()
      ).first()!;

      expect(fromP1.pivot.weight).toBe(5);
      expect(fromP2.pivot.weight).toBe(9);
    });

    it("works on the morphedByMany side too", async () => {
      const tag = await Tag.findOrFail("t-rel");
      const posts = await (tag as any).relations.postsWithPivot().orderBy("id").get();

      expect(posts.toArray().map((p: any) => [p.id, p.pivot.weight])).toEqual([
        ["p1", 5],
        ["p2", 9],
      ]);
    });

    it("still filters by the discriminant when joined", async () => {
      // The join form must carry the type predicate the subquery form has.
      const video = await Video.findOrFail("v1");
      const tags = await (video as any).relations.tags().get();
      expect(tags.count()).toBe(1);
    });

    it("leaves relations without withPivot unchanged", async () => {
      const post = await Post.findOrFail("p1");
      const tag = (await (post as any).relations.tags().get()).first()!;

      expect(tag.pivot).toBeUndefined();
    });
  });

  describe("withTimestamps", () => {
    it("adds created_at/updated_at to the pivot", async () => {
      const post = await Post.findOrFail("p1");
      const tags = await (post as any).relations.tagsWithTimestamps().orderBy("name").get();
      const news = tags.first()!;

      expect(news.pivot.created_at).toBe("2024-01-03");
      expect(news.pivot.updated_at).toBe("2024-01-04");
    });

    it("does not shadow the related model's own timestamp columns", async () => {
      // `tags` has no created_at, so this only proves the prefix keeps
      // the two namespaces apart — but that's exactly the collision the
      // pivot__ prefix exists to prevent.
      const post = await Post.findOrFail("p1");
      const tag = (await (post as any).relations.tagsWithTimestamps().get()).first()!;

      expect(Object.keys(tag.toObject())).toEqual(["id", "name"]);
    });
  });

  describe("eager loading", () => {
    it("batches to two queries regardless of parent count", async () => {
      // 1 posts + 1 pivot + 1 tags = 3 total for the whole page.
      const queries = await countQueries(() => Post.query().with("tags").get());
      expect(queries).toBe(3);
    });

    it("attaches each parent's own tags", async () => {
      const posts = await Post.query().with("tags").orderBy("id").get();
      const [p1, p2] = posts.toArray();

      expect((p1 as any).tags.pluck("name").sort().toArray()).toEqual(["news", "release"]);
      expect((p2 as any).tags.pluck("name").toArray()).toEqual(["release"]);
    });

    it("attaches an empty Collection when a parent has none", async () => {
      await Post.create({ id: "p9", title: "Untagged" });
      const post = await Post.query().with("tags").whereKey("p9").first();

      expect((post as any).tags.toArray()).toEqual([]);
      expect(post!.relationLoaded("tags")).toBe(true);
    });

    it("filters by discriminant across the batch", async () => {
      const videos = await Video.query().with("tags").get();
      expect((videos.first() as any).tags.pluck("name").toArray()).toEqual(["release"]);
    });

    it("carries pivot columns through, per parent", async () => {
      const posts = await Post.query().with("tagsWithPivot").orderBy("id").get();
      const [p1, p2] = posts.toArray();

      const p1Release = (p1 as any).tagsWithPivot.first((t: any) => t.id === "t-rel");
      const p2Release = (p2 as any).tagsWithPivot.first((t: any) => t.id === "t-rel");

      expect(p1Release.pivot.weight).toBe(5);
      expect(p2Release.pivot.weight).toBe(9);
    });

    it("eager-loads the morphedByMany direction", async () => {
      const tags = await Tag.query().with("posts").orderBy("id").get();
      const release = tags.first((t: any) => t.id === "t-rel")!;

      expect((release as any).posts.pluck("id").sort().toArray()).toEqual(["p1", "p2"]);
    });
  });

  describe("withCount / whereHas", () => {
    it("counts links scoped by the discriminant", async () => {
      const posts = await Post.query().withCount("tags").orderBy("id").get();

      expect(posts.toArray().map((p) => [p.id, (p as any).tags_count])).toEqual([
        ["p1", 2],
        ["p2", 1],
      ]);
    });

    it("counts the morphedByMany direction, per type", async () => {
      const tags = await Tag.query().withCount("posts", "videos").orderBy("id").get();

      expect(
        tags.toArray().map((t) => [t.id, (t as any).posts_count, (t as any).videos_count]),
      ).toEqual([
        ["t-news", 1, 0],
        ["t-old", 0, 0],
        ["t-rel", 2, 1],
      ]);
    });

    it("whereHas filters to parents with at least one link", async () => {
      await Post.create({ id: "p9", title: "Untagged" });
      const posts = await Post.query().whereHas("tags").orderBy("id").get();

      expect(posts.pluck("id").toArray()).toEqual(["p1", "p2"]);
    });

    it("whereHas constrains the related model", async () => {
      const posts = await Post.query()
        .whereHas("tags", (q) => q.where("name", "news"))
        .get();

      expect(posts.pluck("id").toArray()).toEqual(["p1"]);
    });

    it("whereDoesntHave is the complement", async () => {
      const tags = await Tag.query().whereDoesntHave("posts").orderBy("id").get();
      expect(tags.pluck("id").toArray()).toEqual(["t-old"]);
    });

    it("distinguishes the two directions in existence queries", async () => {
      // t-news is on a post but no video.
      const withVideos = await Tag.query().whereHas("videos").get();
      expect(withVideos.pluck("id").toArray()).toEqual(["t-rel"]);
    });
  });
});
