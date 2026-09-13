import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model, BaseModel } from "../src/model.js";
import { Relation } from "../src/morph-map.js";
import { MorphToBuilder } from "../src/morph-to-builder.js";
import { morphMany, morphTo } from "../src/relations.js";
import type { MorphMany, MorphTo } from "../src/markers.js";

interface PostAttributes {
  id: string;
  title: string;
  comments: MorphMany<Comment>;
}

interface VideoAttributes {
  id: string;
  url: string;
}

interface CommentAttributes {
  id: string;
  body: string;
  commentable_type: string;
  commentable_id: string;
}

class Comment extends Model<CommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {
  commentable() {
    return this.morphTo({
      morphType: "commentable_type",
      morphId: "commentable_id",
      types: { post: () => Post, video: () => Video },
    });
  }
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  commentsRelation() {
    return this.morphMany(Comment as unknown as typeof BaseModel, {
      morphType: "commentable_type",
      morphId: "commentable_id",
      type: "post",
    });
  }

  static override relationships = {
    comments: morphMany(() => Comment, {
      morphType: "commentable_type",
      morphId: "commentable_id",
      type: "post",
    }),
  };
}

class Video extends Model<VideoAttributes>()({
  table: "videos",
  primaryKey: "id",
  timestamps: false,
}) {
  commentsRelation() {
    return this.morphMany(Comment as unknown as typeof BaseModel, {
      morphType: "commentable_type",
      morphId: "commentable_id",
      type: "video",
    });
  }
}

/**
 * The same three models with every discriminant omitted, `type` on the
 * owning side, `types` on the inverse, so they resolve through
 * `morphAlias()` and the global morph map instead. Declared separately
 * from the explicit models above so both forms stay covered.
 */
class MappedComment extends Model<CommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {
  /** No `types`, resolves through the global morph map alone. */
  commentable() {
    return this.morphTo({ morphType: "commentable_type", morphId: "commentable_id" });
  }
}

interface MappedPostAttributes {
  id: string;
  title: string;
  comments: MorphMany<MappedComment>;
}

class MappedPost extends Model<MappedPostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  /** No `type`, defaults to this model's `morphAlias()`. */
  commentsRelation() {
    return this.morphMany(MappedComment as unknown as typeof BaseModel, {
      morphType: "commentable_type",
      morphId: "commentable_id",
    });
  }

  static override relationships = {
    comments: morphMany(() => MappedComment, {
      morphType: "commentable_type",
      morphId: "commentable_id",
    }),
  };
}

class MappedVideo extends Model<VideoAttributes>()({
  table: "videos",
  primaryKey: "id",
  timestamps: false,
}) {
  commentsRelation() {
    return this.morphMany(MappedComment as unknown as typeof BaseModel, {
      morphType: "commentable_type",
      morphId: "commentable_id",
    });
  }
}

interface DeclaredCommentAttributes {
  id: string;
  body: string;
  commentable_type: string;
  commentable_id: string;
  commentable: MorphTo<Post | Video>;
}

/** A `morphTo` DECLARED in `static relationships`, with a local `types` map. */
class DeclaredComment extends Model<DeclaredCommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    commentable: morphTo<Post | Video>({
      morphType: "commentable_type",
      morphId: "commentable_id",
      types: { post: () => Post, video: () => Video },
    }),
  };
}

interface GlobalCommentAttributes {
  id: string;
  body: string;
  commentable_type: string;
  commentable_id: string;
  commentable: MorphTo<BaseModel>;
}

/** The same declaration with no local `types`, resolves through the global map. */
class GlobalComment extends Model<GlobalCommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    commentable: morphTo<BaseModel>({ morphType: "commentable_type", morphId: "commentable_id" }),
  };
}

describe("Polymorphic relations", () => {
  let app: Application;
  /** Every SELECT executed since the last `resetQueryLog()`. See `countQueries()`. */
  let selectLog: string[] = [];

  /**
   * Runs `fn` and returns how many SELECTs it executed. `morphTo` eager
   * loading is the one relation whose query count is O(distinct types)
   * rather than O(1), so the batching claim needs measuring, not assuming.
   */
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
      // Kysely has no public per-query hook on an existing instance, so
      // wrap `executeQuery` on the driver's executor to record SELECTs.
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
      .createTable("comments")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("commentable_type", "text", (col) => col.notNull())
      .addColumn("commentable_id", "text", (col) => col.notNull())
      .execute();

    await Post.create({ id: "p1", title: "First post" });
    await Post.create({ id: "p2", title: "Second post" });
    await Video.create({ id: "v1", url: "http://example.com/v1" });

    await Comment.create({
      id: "c1",
      body: "on p1",
      commentable_type: "post",
      commentable_id: "p1",
    });
    await Comment.create({
      id: "c2",
      body: "also p1",
      commentable_type: "post",
      commentable_id: "p1",
    });
    await Comment.create({
      id: "c3",
      body: "on v1",
      commentable_type: "video",
      commentable_id: "v1",
    });
  });

  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  describe("morphMany", () => {
    it("returns only comments belonging to this post", async () => {
      const post = await Post.findOrFail("p1");
      const comments = await post.commentsRelation().get();

      expect(comments.pluck("id").sort().toArray()).toEqual(["c1", "c2"]);
    });

    it("scopes by the morph type discriminant", async () => {
      const video = await Video.findOrFail("v1");
      const comments = await video.commentsRelation().get();

      expect(comments.pluck("id").toArray()).toEqual(["c3"]);
    });

    it("returns empty for a parent with no comments", async () => {
      const post = await Post.findOrFail("p2");
      expect((await post.commentsRelation().get()).isEmpty()).toBe(true);
    });
  });

  describe("morphTo", () => {
    it("resolves a comment's parent post", async () => {
      const comment = await Comment.findOrFail("c1");
      const parent = await comment.commentable();

      expect(parent).toMatchObject({ id: "p1", title: "First post" });
    });

    it("resolves a comment's parent video (different model via discriminant)", async () => {
      const comment = await Comment.findOrFail("c3");
      const parent = await comment.commentable();

      expect(parent).toMatchObject({ id: "v1", url: "http://example.com/v1" });
    });

    it("returns undefined for an unknown discriminant value", async () => {
      await Comment.create({
        id: "c4",
        body: "orphan",
        commentable_type: "unknown",
        commentable_id: "x",
      });
      const comment = await Comment.findOrFail("c4");

      expect(await comment.commentable()).toBeUndefined();
    });
  });

  describe("with()/withCount() for morphMany", () => {
    it("eager-loads comments across a page in one extra query", async () => {
      const posts = await Post.query().with("comments").orderBy("id").get();
      const [p1, p2] = posts.toArray();

      expect((p1 as any).comments.pluck("id").sort().toArray()).toEqual(["c1", "c2"]);
      expect((p2 as any).comments.toArray()).toEqual([]);
    });

    it("withCount adds a comments_count column, scoped by type", async () => {
      const posts = await Post.query().withCount("comments").orderBy("id").get();

      expect(posts.toArray().map((p) => [p.id, (p as any).comments_count])).toEqual([
        ["p1", 2],
        ["p2", 0],
      ]);
    });

    it("whereHas filters posts that have comments", async () => {
      const posts = await Post.query().whereHas("comments").orderBy("id").get();
      expect(posts.pluck("id").toArray()).toEqual(["p1"]);
    });
  });

  describe("optional discriminants", () => {
    /**
     * The seeded rows store `"post"`/`"video"`, so a map pinning those
     * aliases is what makes the omitted-discriminant models agree with
     * the explicit ones on the same data.
     */
    const mapRows = () => {
      Relation.morphMap({ post: () => MappedPost, video: () => MappedVideo });
    };

    describe("morphMany without an explicit type", () => {
      it("defaults the discriminant to the declaring model's morphAlias()", async () => {
        mapRows();
        const post = await MappedPost.findOrFail("p1");

        expect((await post.commentsRelation().get()).pluck("id").sort().toArray()).toEqual([
          "c1",
          "c2",
        ]);
      });

      it("still scopes by type, so a different parent gets different rows", async () => {
        mapRows();
        const video = await MappedVideo.findOrFail("v1");

        expect((await video.commentsRelation().get()).pluck("id").toArray()).toEqual(["c3"]);
      });

      it("falls back to morphName when the model is unmapped", async () => {
        // No morph map registered; MappedPost has no morphName either, so
        // it falls all the way to `table`. Which is "posts", not "post",
        // and therefore matches nothing in the seeded data.
        const post = await MappedPost.findOrFail("p1");
        expect((await post.commentsRelation().get()).isEmpty()).toBe(true);

        // Registering the alias the rows actually store fixes it.
        mapRows();
        const remapped = await MappedPost.findOrFail("p1");
        expect((await remapped.commentsRelation().get()).count()).toBe(2);
      });

      it("lets an explicit type override the default", async () => {
        // Post declares `type: "post"` explicitly while a map would say
        // otherwise, explicit wins.
        Relation.morphMap({ post: () => Video, video: () => Post });
        const post = await Post.findOrFail("p1");

        expect((await post.commentsRelation().get()).pluck("id").sort().toArray()).toEqual([
          "c1",
          "c2",
        ]);
      });
    });

    describe("eager loading and existence queries", () => {
      it("with() defaults the discriminant the same way", async () => {
        mapRows();
        const posts = await MappedPost.query().with("comments").orderBy("id").get();
        const [p1, p2] = posts.toArray();

        expect((p1 as any).comments.pluck("id").sort().toArray()).toEqual(["c1", "c2"]);
        expect((p2 as any).comments.toArray()).toEqual([]);
      });

      it("withCount() defaults the discriminant the same way", async () => {
        mapRows();
        const posts = await MappedPost.query().withCount("comments").orderBy("id").get();

        expect(posts.toArray().map((p) => [p.id, (p as any).comments_count])).toEqual([
          ["p1", 2],
          ["p2", 0],
        ]);
      });

      it("whereHas() defaults the discriminant the same way", async () => {
        mapRows();
        const posts = await MappedPost.query().whereHas("comments").orderBy("id").get();

        expect(posts.pluck("id").toArray()).toEqual(["p1"]);
      });

      it("all four sites agree on the default", async () => {
        // The defaulting rule is implemented at four independent sites
        // (static helper, instance helper, eager loader, subquery
        // builder). This pins them together: an unmapped model must
        // resolve to the same "no rows" answer everywhere.
        const post = await MappedPost.findOrFail("p1");
        expect((await post.commentsRelation().get()).isEmpty()).toBe(true);

        const eager = await MappedPost.query().with("comments").whereKey("p1").first();
        expect((eager as any).comments.toArray()).toEqual([]);

        const counted = await MappedPost.query().withCount("comments").whereKey("p1").first();
        expect((counted as any).comments_count).toBe(0);

        expect((await MappedPost.query().whereHas("comments").get()).isEmpty()).toBe(true);
      });
    });

    describe("morphTo without an explicit types map", () => {
      it("resolves the discriminant through the global morph map", async () => {
        mapRows();
        const comment = await MappedComment.findOrFail("c1");

        expect(await comment.commentable()).toMatchObject({ id: "p1", title: "First post" });
      });

      it("resolves a different type through the same map", async () => {
        mapRows();
        const comment = await MappedComment.findOrFail("c3");

        expect(await comment.commentable()).toMatchObject({
          id: "v1",
          url: "http://example.com/v1",
        });
      });

      it("returns undefined when the map has no entry for the value", async () => {
        // Unresolvable discriminants behave like a dangling FK, not a throw.
        const comment = await MappedComment.findOrFail("c1");
        expect(await comment.commentable()).toBeUndefined();
      });

      it("prefers a local types entry over the global map", async () => {
        // The map says "post" is a Video; the local types map says Post.
        // Local wins, so a PostTable row comes back.
        Relation.morphMap({ post: () => Video });
        const comment = await Comment.findOrFail("c1");

        expect(await comment.commentable()).toMatchObject({ id: "p1", title: "First post" });
      });

      it("falls back to the map for a value absent from local types", async () => {
        // Comment's local types covers post/video only; the map supplies
        // the rest, so both sources compose rather than one shadowing the
        // other wholesale.
        await Comment.create({
          id: "c5",
          body: "on an article",
          commentable_type: "article",
          commentable_id: "p2",
        });
        Relation.morphMap({ article: () => Post });

        const comment = await Comment.findOrFail("c5");
        expect(await comment.commentable()).toMatchObject({ id: "p2", title: "Second post" });
      });
    });
  });

  describe("morphTo as a declared relation", () => {
    describe("the relations namespace", () => {
      it("returns a MorphToBuilder, not a promise", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        const builder = (comment as any).relations.commentable();

        expect(builder).toBeInstanceOf(MorphToBuilder);
        expect(typeof builder.first).toBe("function");
      });

      it("resolves the parent via first()", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        const parent = await (comment as any).relations.commentable().first();

        expect(parent).toMatchObject({ id: "p1", title: "First post" });
      });

      it("resolves a different model through the same declaration", async () => {
        const comment = await DeclaredComment.findOrFail("c3");
        const parent = await (comment as any).relations.commentable().first();

        expect(parent).toMatchObject({ id: "v1", url: "http://example.com/v1" });
      });

      it("exposes the resolved target class before querying", async () => {
        const comment = await DeclaredComment.findOrFail("c3");
        expect((comment as any).relations.commentable().targetClass()).toBe(Video);
      });

      it("resolves undefined for an unknown discriminant rather than throwing", async () => {
        await DeclaredComment.create({
          id: "c9",
          body: "orphan",
          commentable_type: "unknown",
          commentable_id: "x",
        });
        const comment = await DeclaredComment.findOrFail("c9");
        const builder = (comment as any).relations.commentable();

        expect(builder.targetClass()).toBeUndefined();
        expect(await builder.first()).toBeUndefined();
        expect(await builder.exists()).toBe(false);
      });

      it("resolves undefined when the parent row is missing", async () => {
        await DeclaredComment.create({
          id: "c10",
          body: "dangling",
          commentable_type: "post",
          commentable_id: "gone",
        });
        const comment = await DeclaredComment.findOrFail("c10");

        expect(await (comment as any).relations.commentable().first()).toBeUndefined();
      });

      it("falls back to the global map when the declaration has no types", async () => {
        Relation.morphMap({ post: () => Post, video: () => Video });
        const comment = await GlobalComment.findOrFail("c1");

        expect(await (comment as any).relations.commentable().first()).toMatchObject({ id: "p1" });
      });
    });

    describe("constrain()", () => {
      it("applies the callback matching the resolved type", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        const parent = await (comment as any).relations
          .commentable()
          .constrain({ post: (q: any) => q.where("title", "First post") })
          .first();

        expect(parent).toMatchObject({ id: "p1" });
      });

      it("filters the parent out when its callback doesn't match", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        const parent = await (comment as any).relations
          .commentable()
          .constrain({ post: (q: any) => q.where("title", "Nope") })
          .first();

        expect(parent).toBeUndefined();
      });

      it("leaves types absent from the map unconstrained", async () => {
        // The comment resolves to a Video; only `post` is constrained,
        // so the video comes back untouched.
        const comment = await DeclaredComment.findOrFail("c3");
        const parent = await (comment as any).relations
          .commentable()
          .constrain({ post: (q: any) => q.where("title", "Nope") })
          .first();

        expect(parent).toMatchObject({ id: "v1" });
      });

      it("merges across successive calls", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        const parent = await (comment as any).relations
          .commentable()
          .constrain({ video: (q: any) => q.where("url", "x") })
          .constrain({ post: (q: any) => q.where("title", "First post") })
          .first();

        expect(parent).toMatchObject({ id: "p1" });
      });
    });

    describe("eager loading", () => {
      it("loads parents across a page of mixed types", async () => {
        const comments = await DeclaredComment.query().with("commentable").orderBy("id").get();
        const [c1, c2, c3] = comments.toArray();

        expect((c1 as any).commentable).toMatchObject({ id: "p1", title: "First post" });
        expect((c2 as any).commentable).toMatchObject({ id: "p1", title: "First post" });
        expect((c3 as any).commentable).toMatchObject({ id: "v1", url: "http://example.com/v1" });
      });

      it("issues one query per DISTINCT type, not one per row", async () => {
        // Three comments spanning two types: 1 for the comments +
        // 1 posts + 1 videos = 3. The O(1)-per-relation guarantee every
        // other relation makes does not hold here, and this pins the
        // actual shape rather than leaving it implied.
        const queries = await countQueries(() =>
          DeclaredComment.query().with("commentable").orderBy("id").get(),
        );

        expect(queries).toBe(3);
      });

      it("does not grow with row count", async () => {
        for (let i = 0; i < 10; i++) {
          await DeclaredComment.create({
            id: `bulk${i}`,
            body: "bulk",
            commentable_type: "post",
            commentable_id: "p1",
          });
        }

        // 13 rows, still two distinct types.
        const queries = await countQueries(() => DeclaredComment.query().with("commentable").get());
        expect(queries).toBe(3);
      });

      it("attaches undefined for an unresolvable discriminant", async () => {
        await DeclaredComment.create({
          id: "c11",
          body: "orphan",
          commentable_type: "unknown",
          commentable_id: "x",
        });

        const comment = await DeclaredComment.query().with("commentable").whereKey("c11").first();
        expect((comment as any).commentable).toBeUndefined();
        expect(comment!.relationLoaded("commentable")).toBe(true);
      });

      it("distinguishes parents whose ids collide across types", async () => {
        // Post "shared" and Video "shared" are different parents. A
        // loader keyed on id alone would attach the wrong one.
        await Post.create({ id: "shared", title: "The post" });
        await Video.create({ id: "shared", url: "the-video" });
        await DeclaredComment.create({
          id: "cp",
          body: "on post",
          commentable_type: "post",
          commentable_id: "shared",
        });
        await DeclaredComment.create({
          id: "cv",
          body: "on video",
          commentable_type: "video",
          commentable_id: "shared",
        });

        const comments = await DeclaredComment.query()
          .with("commentable")
          .whereIn("id", ["cp", "cv"])
          .orderBy("id")
          .get();
        const [cp, cv] = comments.toArray();

        expect((cp as any).commentable).toMatchObject({ title: "The post" });
        expect((cv as any).commentable).toMatchObject({ url: "the-video" });
      });

      it("works through load() on already-fetched instances", async () => {
        const comment = await DeclaredComment.findOrFail("c1");
        await comment.load("commentable");

        expect((comment as any).commentable).toMatchObject({ id: "p1" });
      });

      it("resolves through the global map when types is absent", async () => {
        Relation.morphMap({ post: () => Post, video: () => Video });
        const comments = await GlobalComment.query().with("commentable").orderBy("id").get();

        expect((comments.first() as any).commentable).toMatchObject({ id: "p1" });
      });
    });

    describe("directive errors", () => {
      it("rejects whereHas() with a pointer to whereHasMorph()", () => {
        expect(() => DeclaredComment.query().whereHas("commentable" as never)).toThrow(
          /cannot be used on a morphTo relation/,
        );
      });

      it("rejects withCount() the same way", () => {
        expect(() => DeclaredComment.query().withCount("commentable" as never)).toThrow(
          /whereHasMorph\(\)/,
        );
      });

      it("rejects whereDoesntHave() the same way", () => {
        expect(() => DeclaredComment.query().whereDoesntHave("commentable" as never)).toThrow(
          /cannot be used on a morphTo relation/,
        );
      });
    });
  });
});
