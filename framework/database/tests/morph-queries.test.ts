import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Relation } from "../src/morph-map.js";
import { belongsTo, morphTo } from "../src/relations.js";
import type { BelongsTo, MorphTo } from "../src/markers.js";

interface PostAttributes {
  id: string;
  title: string;
  published: number;
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
  author_id: string | null;
  commentable: MorphTo<Post | Video>;
  author: BelongsTo<Author>;
}

interface AuthorAttributes {
  id: string;
  name: string;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
  morphName: "post",
}) {}

class Video extends Model<VideoAttributes>()({
  table: "videos",
  primaryKey: "id",
  timestamps: false,
  morphName: "video",
}) {}

class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  timestamps: false,
}) {}

class Comment extends Model<CommentAttributes>()({
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
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
  };
}

describe("Morph-aware query methods", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();

    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(1))
      .execute();

    await kysely.schema
      .createTable("videos")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("url", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("authors")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("comments")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("commentable_type", "text", (col) => col.notNull())
      .addColumn("commentable_id", "text", (col) => col.notNull())
      .addColumn("author_id", "text")
      .execute();

    await Post.create({ id: "p1", title: "First post", published: 1 });
    await Post.create({ id: "p2", title: "Draft post", published: 0 });
    await Video.create({ id: "v1", url: "http://example.com/v1" });
    await Author.create({ id: "a1", name: "Ada" });

    // c1,c2 -> p1;  c3 -> p2 (unpublished);  c4 -> v1;
    // c5 -> a post that no longer exists;  c6 -> an unregistered type.
    await Comment.create({
      id: "c1",
      body: "on p1",
      commentable_type: "post",
      commentable_id: "p1",
      author_id: "a1",
    });
    await Comment.create({
      id: "c2",
      body: "also p1",
      commentable_type: "post",
      commentable_id: "p1",
      author_id: null,
    });
    await Comment.create({
      id: "c3",
      body: "on p2",
      commentable_type: "post",
      commentable_id: "p2",
      author_id: null,
    });
    await Comment.create({
      id: "c4",
      body: "on v1",
      commentable_type: "video",
      commentable_id: "v1",
      author_id: null,
    });
    await Comment.create({
      id: "c5",
      body: "dangling",
      commentable_type: "post",
      commentable_id: "gone",
      author_id: null,
    });
    await Comment.create({
      id: "c6",
      body: "unknown",
      commentable_type: "sticker",
      commentable_id: "s1",
      author_id: null,
    });
  });

  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  describe("whereMorphedTo()", () => {
    it("filters to comments pointing at one specific instance", async () => {
      const post = await Post.findOrFail("p1");
      const comments = await Comment.query()
        .whereMorphedTo("commentable", post)
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2"]);
    });

    it("separates two parents of different types sharing an id", async () => {
      await Post.create({ id: "same", title: "Post same", published: 1 });
      await Video.create({ id: "same", url: "video-same" });
      await Comment.create({
        id: "cp",
        body: "p",
        commentable_type: "post",
        commentable_id: "same",
        author_id: null,
      });
      await Comment.create({
        id: "cv",
        body: "v",
        commentable_type: "video",
        commentable_id: "same",
        author_id: null,
      });

      const post = await Post.findOrFail("same");
      const video = await Video.findOrFail("same");

      expect(
        (await Comment.query().whereMorphedTo("commentable", post).get()).pluck("id").toArray(),
      ).toEqual(["cp"]);
      expect(
        (await Comment.query().whereMorphedTo("commentable", video).get()).pluck("id").toArray(),
      ).toEqual(["cv"]);
    });

    it("emits no subquery — both columns are on this table", async () => {
      const post = await Post.findOrFail("p1");
      const sql = Comment.query().whereMorphedTo("commentable", post).toSql().toLowerCase();

      expect(sql).not.toContain("exists");
      // Exactly one SELECT: the outer one.
      expect(sql.split("select").length - 1).toBe(1);
    });

    it("uses the related model's morphAlias(), honouring the morph map", async () => {
      Relation.morphMap({ article: () => Post });
      const post = await Post.findOrFail("p1");

      // The map now says Post is "article", but the rows store "post" —
      // so nothing matches. Proves the alias is read, not hardcoded.
      expect((await Comment.query().whereMorphedTo("commentable", post).get()).isEmpty()).toBe(
        true,
      );
    });

    it("whereNotMorphedTo is its complement", async () => {
      const post = await Post.findOrFail("p1");
      const comments = await Comment.query()
        .whereNotMorphedTo("commentable", post)
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c3", "c4", "c5", "c6"]);
    });

    it("negates the pair as a unit, not just the discriminant", async () => {
      // A naive NOT would negate only `type = post` and leave `id = p1`
      // ANDed on, dropping c3 (a post comment with a different id).
      const post = await Post.findOrFail("p1");
      const ids = (await Comment.query().whereNotMorphedTo("commentable", post).get())
        .pluck("id")
        .toArray();

      expect(ids).toContain("c3");
      expect(ids).toContain("c4");
    });

    it("composes with OR", async () => {
      const post = await Post.findOrFail("p2");
      const video = await Video.findOrFail("v1");

      const comments = await Comment.query()
        .whereMorphedTo("commentable", post)
        .orWhereMorphedTo("commentable", video)
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c3", "c4"]);
    });

    it("composes with ordinary where clauses", async () => {
      const post = await Post.findOrFail("p1");
      const comments = await Comment.query()
        .whereMorphedTo("commentable", post)
        .whereNotNull("author_id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c1"]);
    });

    it("throws when the named relation isn't a morphTo", () => {
      // `MorphToKeys` rejects this at compile time wherever TRelations is
      // a real map, but `Model.query()` supplies `any`, so the runtime
      // guard is what fires here. Keep both.
      expect(() => Comment.query().whereMorphedTo("author" as never, {} as any)).toThrow(
        /is not a morphTo relation/,
      );
    });

    it("throws for a relation name that doesn't exist", () => {
      expect(() => Comment.query().whereMorphedTo("nope" as never, {} as any)).toThrow(
        /no relation named "nope"/,
      );
    });
  });

  describe("whereHasMorph()", () => {
    it("matches comments whose parent exists, across several types", async () => {
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post, Video])
        .orderBy("id")
        .get();

      // c5 (dangling) and c6 (unregistered type) are excluded.
      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2", "c3", "c4"]);
    });

    it("restricts to the listed types only", async () => {
      const comments = await Comment.query().whereHasMorph("commentable", [Video]).get();
      expect(comments.pluck("id").toArray()).toEqual(["c4"]);
    });

    it("excludes rows whose parent row is missing", async () => {
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post])
        .orderBy("id")
        .get();
      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2", "c3"]);
      expect(comments.pluck("id").toArray()).not.toContain("c5");
    });

    it("applies a constraining callback to the target model", async () => {
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post], (q) => q.where("published", 1))
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2"]);
    });

    it("passes the discriminant to the callback so it can branch per type", async () => {
      const seen: string[] = [];
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post, Video], (q, type) => {
          seen.push(type);

          if (type === "post") {
            q.where("published", 1);
          }
        })
        .orderBy("id")
        .get();

      expect(seen.sort()).toEqual(["post", "video"]);
      // Published posts + the video; the draft post's comment drops out.
      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2", "c4"]);
    });

    it("keeps each type's constraint bound to its own discriminant", async () => {
      // If the disjuncts flattened, the video would be matched by the
      // post branch's EXISTS and survive the `published` filter.
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post], (q) => q.where("published", 1))
        .get();

      expect(comments.pluck("id").toArray()).not.toContain("c4");
    });

    it("composes with ordinary where clauses", async () => {
      const comments = await Comment.query()
        .whereHasMorph("commentable", [Post, Video])
        .whereNotNull("author_id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c1"]);
    });

    it("composes with OR", async () => {
      const comments = await Comment.query()
        .where("id", "c6")
        .orWhereHasMorph("commentable", [Video])
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c4", "c6"]);
    });

    it("throws when the named relation isn't a morphTo", () => {
      expect(() => Comment.query().whereHasMorph("author" as never, [Post])).toThrow(
        /is not a morphTo relation/,
      );
    });

    it("works when the target is the queried table itself", async () => {
      // A comment on a comment — the self-referential case the __sub
      // alias exists for. Comment has no morphName, so its alias falls
      // through to the table name; store exactly that.
      await Comment.create({
        id: "c7",
        body: "reply",
        commentable_type: Comment.morphAlias(),
        commentable_id: "c1",
        author_id: null,
      });

      const comments = await Comment.query().whereHasMorph("commentable", [Comment]).get();
      expect(comments.pluck("id").toArray()).toEqual(["c7"]);
    });

    it("correlates the self-referential case against the outer row", async () => {
      // Without the __sub alias this would compare the inner comment to
      // itself and match every row with a resolvable parent.
      await Comment.create({
        id: "c8",
        body: "dangling reply",
        commentable_type: Comment.morphAlias(),
        commentable_id: "nope",
        author_id: null,
      });

      const comments = await Comment.query().whereHasMorph("commentable", [Comment]).get();
      expect(comments.pluck("id").toArray()).not.toContain("c8");
    });
  });

  describe("whereDoesntHaveMorph()", () => {
    it("is the complement of whereHasMorph", async () => {
      const comments = await Comment.query()
        .whereDoesntHaveMorph("commentable", [Post, Video])
        .orderBy("id")
        .get();

      expect(comments.pluck("id").toArray()).toEqual(["c5", "c6"]);
    });

    it("finds orphaned rows for one type", async () => {
      const comments = await Comment.query()
        .whereDoesntHaveMorph("commentable", [Post])
        .orderBy("id")
        .get();

      // Everything that isn't a comment on an existing post.
      expect(comments.pluck("id").toArray()).toEqual(["c4", "c5", "c6"]);
    });

    it("honours a constraining callback", async () => {
      const comments = await Comment.query()
        .whereDoesntHaveMorph("commentable", [Post], (q) => q.where("published", 1))
        .orderBy("id")
        .get();

      // c3's post exists but is unpublished, so it counts as "doesn't have".
      expect(comments.pluck("id").toArray()).toEqual(["c3", "c4", "c5", "c6"]);
    });
  });

  describe('the "*" wildcard', () => {
    it("expands to every entry in the global morph map", async () => {
      Relation.morphMap({ post: () => Post, video: () => Video });
      const comments = await Comment.query().whereHasMorph("commentable", "*").orderBy("id").get();

      expect(comments.pluck("id").toArray()).toEqual(["c1", "c2", "c3", "c4"]);
    });

    it("covers only the registered types", async () => {
      Relation.morphMap({ video: () => Video });
      const comments = await Comment.query().whereHasMorph("commentable", "*").get();

      expect(comments.pluck("id").toArray()).toEqual(["c4"]);
    });

    it("throws when the map is empty rather than matching nothing", () => {
      expect(() => Comment.query().whereHasMorph("commentable", "*")).toThrow(
        /the morph map is empty/,
      );
      expect(() => Comment.query().whereHasMorph("commentable", "*")).toThrow(/Relation\.morphMap/);
    });

    it("passes each mapped alias to the constraint callback", async () => {
      Relation.morphMap({ post: () => Post, video: () => Video });
      const seen: string[] = [];

      await Comment.query()
        .whereHasMorph("commentable", "*", (_q, type) => {
          seen.push(type);
        })
        .get();

      expect(seen.sort()).toEqual(["post", "video"]);
    });
  });
});
