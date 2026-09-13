import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { belongsTo, belongsToMany, hasMany, morphTo } from "../src/relations.js";
import type { BelongsTo, BelongsToMany, HasMany, MorphTo } from "../src/markers.js";
import { Relation } from "../src/morph-map.js";

/**
 * Nested (dot-path) eager loading, constraining closures, and `morphWith`.
 *
 * The important assertions here are the **query counts**. Correct
 * values prove nothing on their own: a naive per-instance implementation
 * returns exactly the same data as a batched one and differs only in how
 * many statements it took to get there. Since the whole promise of the
 * feature is "one query per relation node, independent of row count", the
 * counts are the feature.
 */

interface TeamAttributes {
  id: string;
  name: string;
  members: HasMany<Author>;
}

interface AuthorAttributes {
  id: string;
  team_id: string | null;
  name: string;
  team: BelongsTo<Team>;
  posts: HasMany<Post>;
}

interface PostAttributes {
  id: string;
  author_id: string | null;
  parent_id: string | null;
  title: string;
  author: BelongsTo<Author>;
  comments: HasMany<Comment>;
  replies: HasMany<Post>;
  tags: BelongsToMany<Tag>;
}

interface CommentAttributes {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  approved: number;
  author: BelongsTo<Author>;
}

interface TagAttributes {
  id: string;
  label: string;
}

interface NoteAttributes {
  id: string;
  body: string;
  notable_type: string;
  notable_id: string;
  notable: MorphTo<Post | Author>;
}

class Team extends Model<TeamAttributes>()({
  table: "teams",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    members: hasMany(() => Author, { foreignKey: "team_id" }),
  };
}

class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    team: belongsTo(() => Team, { foreignKey: "team_id" }),
    posts: hasMany(() => Post, { foreignKey: "author_id" }),
  };
}

class Tag extends Model<TagAttributes>()({
  table: "tags",
  primaryKey: "id",
  timestamps: false,
}) {}

class Comment extends Model<CommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
  };
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
    // Self-referential: the shape that makes a recursive path type
    // non-terminating without a depth cap.
    replies: hasMany(() => Post, { foreignKey: "parent_id" }),
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
    }),
  };
}

/** A `morphTo` pointing at two models with DIFFERENT relations, what `morphWith` exists for. */
class Note extends Model<NoteAttributes>()({
  table: "notes",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    notable: morphTo<Post | Author>({
      morphType: "notable_type",
      morphId: "notable_id",
      types: { post: () => Post, author: () => Author },
    }),
  };
}

describe("Nested eager loading", () => {
  let app: Application;
  let selectLog: string[] = [];

  /** Runs `fn` and returns how many SELECTs it executed. */
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
      .createTable("teams")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("authors")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("team_id", "text")
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("author_id", "text")
      .addColumn("parent_id", "text")
      .addColumn("title", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("comments")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("post_id", "text", (col) => col.notNull())
      .addColumn("author_id", "text", (col) => col.notNull())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("approved", "integer", (col) => col.notNull())
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

    await kysely.schema
      .createTable("notes")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("notable_type", "text", (col) => col.notNull())
      .addColumn("notable_id", "text", (col) => col.notNull())
      .execute();

    await Team.create({ id: "t1", name: "Platform" });
    await Team.create({ id: "t2", name: "Growth" });

    await Author.create({ id: "a1", team_id: "t1", name: "Ada" });
    await Author.create({ id: "a2", team_id: "t2", name: "Bo" });
    await Author.create({ id: "a3", team_id: null, name: "Cy" });

    // p1/p2 share author a1. The case that makes de-duplication in
    // `collectRelated` observable.
    await Post.create({ id: "p1", author_id: "a1", parent_id: null, title: "First" });
    await Post.create({ id: "p2", author_id: "a1", parent_id: null, title: "Second" });
    await Post.create({ id: "p3", author_id: "a2", parent_id: null, title: "Third" });
    await Post.create({ id: "p4", author_id: "a3", parent_id: "p1", title: "Reply to first" });
    await Post.create({ id: "p5", author_id: "a1", parent_id: "p4", title: "Reply to reply" });

    await Comment.create({ id: "c1", post_id: "p1", author_id: "a2", body: "yes", approved: 1 });
    await Comment.create({ id: "c2", post_id: "p1", author_id: "a3", body: "no", approved: 0 });
    await Comment.create({ id: "c3", post_id: "p2", author_id: "a2", body: "maybe", approved: 1 });

    await Tag.create({ id: "g1", label: "ts" });
    await kysely.insertInto("post_tag").values({ post_id: "p1", tag_id: "g1" }).execute();

    await Note.create({ id: "n1", body: "on p1", notable_type: "post", notable_id: "p1" });
    await Note.create({ id: "n2", body: "on a1", notable_type: "author", notable_id: "a1" });
    await Note.create({ id: "n3", body: "on p3", notable_type: "post", notable_id: "p3" });
  });

  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  describe("dot paths", () => {
    it("loads a two-level path through a to-one", async () => {
      const posts = await Post.query().with("author.team").get();
      const p1 = posts.first((p) => p.id === "p1")!;

      expect((p1 as any).author.name).toBe("Ada");
      expect((p1 as any).author.team.name).toBe("Platform");
    });

    it("loads a three-level path", async () => {
      const posts = await Post.query().where("id", "p1").with("author.team.members").get();
      const p1 = posts.first()!;

      const members = (p1 as any).author.team.members;
      expect(members.pluck("id").toArray()).toEqual(["a1"]);
    });

    it("uses one query per node, not per row", async () => {
      // 1 posts + 1 authors + 1 teams = 3, for 5 posts across 3 authors.
      const queries = await countQueries(() => Post.query().with("author.team").get());
      expect(queries).toBe(3);
    });

    it("holds that count as the row count grows", async () => {
      for (let i = 0; i < 40; i++) {
        await Post.create({ id: `bulk${i}`, author_id: "a1", parent_id: null, title: `Bulk ${i}` });
      }

      const queries = await countQueries(() => Post.query().with("author.team").get());
      expect(queries).toBe(3);
    });

    it("loads a path through a to-many", async () => {
      const posts = await Post.query().where("id", "p1").with("comments.author.team").get();
      const p1 = posts.first()!;

      const comments = (p1 as any).comments;
      expect(comments.count()).toBe(2);

      const c1 = comments.first((c: any) => c.id === "c1")!;
      expect(c1.author.name).toBe("Bo");
      expect(c1.author.team.name).toBe("Growth");
    });

    it("still batches through a to-many", async () => {
      // posts + comments + authors + teams
      const queries = await countQueries(() => Post.query().with("comments.author.team").get());
      expect(queries).toBe(4);
    });

    it("loads nested relations on a belongsToMany", async () => {
      const posts = await Post.query().where("id", "p1").with("tags").get();
      expect((posts.first()! as any).tags.pluck("label").toArray()).toEqual(["ts"]);
    });

    it("attaches undefined for a to-one that resolves to nothing mid-path", async () => {
      const posts = await Post.query().where("id", "p4").with("author.team").get();
      const p4 = posts.first()!;

      // a3 has a null team_id, the path stops there rather than throwing.
      expect((p4 as any).author.name).toBe("Cy");
      expect((p4 as any).author.team).toBeUndefined();
    });

    it("works from first() as well as get()", async () => {
      const post = await Post.query().where("id", "p1").with("author.team").first();
      expect((post as any).author.team.name).toBe("Platform");
    });
  });

  describe("merge semantics", () => {
    it("merges sibling paths into a single parent query", async () => {
      // Laravel's parseWithRelations rule: `a.b` + `a.c` is ONE `a` node.
      // posts + authors + teams + authors' posts = 4, not 5.
      const queries = await countQueries(() =>
        Post.query().with("author.team", "author.posts").get(),
      );
      expect(queries).toBe(4);
    });

    it("attaches both children of a merged node", async () => {
      const posts = await Post.query().where("id", "p1").with("author.team", "author.posts").get();
      const author = (posts.first()! as any).author;

      expect(author.team.name).toBe("Platform");
      expect(author.posts.pluck("id").sort().toArray()).toEqual(["p1", "p2", "p5"]);
    });

    it("merges a bare name with a path under it", async () => {
      const queries = await countQueries(() => Post.query().with("author", "author.team").get());
      expect(queries).toBe(3);
    });

    it("merges across separate with() calls", async () => {
      const queries = await countQueries(() =>
        Post.query().with("author.team").with("author.posts").get(),
      );
      expect(queries).toBe(4);
    });

    it("de-duplicates shared parents before descending", async () => {
      // p1/p2/p5 all point at a1. The `teams` query must run against ONE
      // author, not three copies of it.
      const posts = await Post.query().with("author.team").get();
      const p1 = posts.first((p) => p.id === "p1")!;
      const p2 = posts.first((p) => p.id === "p2")!;

      expect((p1 as any).author).toBe((p2 as any).author);
      expect((p1 as any).author.team.name).toBe("Platform");
    });
  });

  describe("self-referential nesting", () => {
    it("loads replies of replies", async () => {
      const posts = await Post.query().where("id", "p1").with("replies.replies").get();
      const p1 = posts.first()!;

      const replies = (p1 as any).replies;
      expect(replies.pluck("id").toArray()).toEqual(["p4"]);
      expect(replies.first()!.replies.pluck("id").toArray()).toEqual(["p5"]);
    });

    it("stops at the requested depth rather than recursing forever", async () => {
      const posts = await Post.query().where("id", "p1").with("replies.replies").get();
      const nested = (posts.first()! as any).replies.first()!.replies.first()!;

      // p5's own replies were never requested, so they're simply not loaded.
      expect(nested.relationLoaded("replies")).toBe(false);
    });

    it("costs one query per level", async () => {
      const queries = await countQueries(() => Post.query().with("replies.replies.replies").get());
      expect(queries).toBe(4);
    });
  });

  describe("errors", () => {
    it("names the failing segment, not the whole path", async () => {
      await expect(
        Post.query()
          .with("author.nope" as any)
          .get(),
      ).rejects.toThrow(/no relation named "nope" is declared in authors/);
    });

    it("still reports an unknown first segment against the root model", async () => {
      await expect(
        Post.query()
          .with("nope" as any)
          .get(),
      ).rejects.toThrow(/no relation named "nope" is declared in posts/);
    });

    it("rejects a malformed path with a doubled dot", () => {
      expect(() => Post.query().with("author..team" as any)).toThrow(/empty segment/);
    });
  });

  describe("constraining closures", () => {
    it("narrows a to-many", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ comments: (q) => q.where("approved", 1) })
        .get();

      expect((posts.first()! as any).comments.pluck("id").toArray()).toEqual(["c1"]);
    });

    it("attaches an empty collection when a to-many constraint excludes everything", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ comments: (q) => q.where("approved", 99) })
        .get();

      expect((posts.first()! as any).comments.count()).toBe(0);
    });

    it("attaches undefined when a to-one constraint excludes the row", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ author: (q) => q.where("name", "Nobody") })
        .get();

      expect((posts.first()! as any).author).toBeUndefined();
    });

    it("does not change the query count", async () => {
      const queries = await countQueries(() =>
        Post.query()
          .with({ comments: (q) => q.where("approved", 1) })
          .get(),
      );
      expect(queries).toBe(2);
    });

    it("constrains a nested path segment", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ "comments.author": (q) => q.where("name", "Bo") })
        .get();

      const comments = (posts.first()! as any).comments;
      expect(comments.first((c: any) => c.id === "c1")!.author.name).toBe("Bo");
      // c2's author (Cy) was filtered out of the batch.
      expect(comments.first((c: any) => c.id === "c2")!.author).toBeUndefined();
    });

    it("combines a constraint with dot-path children", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ comments: (q) => q.where("approved", 1) })
        .with("comments.author")
        .get();

      const comments = (posts.first()! as any).comments;
      expect(comments.pluck("id").toArray()).toEqual(["c1"]);
      expect(comments.first()!.author.name).toBe("Bo");
    });

    it("supports orderBy inside a constraint", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .with({ comments: (q) => q.orderBy("id", "desc") })
        .get();

      expect((posts.first()! as any).comments.pluck("id").toArray()).toEqual(["c2", "c1"]);
    });

    it("throws when limit() is called inside a constraint", async () => {
      await expect(
        Post.query()
          .with({ comments: (q) => q.limit(1) })
          .get(),
      ).rejects.toThrow(/limit\(\) isn't supported inside an eager-load constraint/);
    });

    it("throws for take()/offset()/skip() too", async () => {
      await expect(
        Post.query()
          .with({ comments: (q) => q.take(1) })
          .get(),
      ).rejects.toThrow(/take\(\) isn't supported/);

      await expect(
        Post.query()
          .with({ comments: (q) => q.offset(1) })
          .get(),
      ).rejects.toThrow(/offset\(\) isn't supported/);

      await expect(
        Post.query()
          .with({ comments: (q) => q.skip(1) })
          .get(),
      ).rejects.toThrow(/skip\(\) isn't supported/);
    });

    it("leaves limit() working on an unconstrained builder", async () => {
      // The guard is installed per constrained eager-load builder only.
      // It must not leak onto ordinary queries.
      const posts = await Post.query().limit(2).get();
      expect(posts.count()).toBe(2);
    });
  });

  describe("clone isolation", () => {
    it("does not share eager-load nodes between a builder and its clone", async () => {
      const base = Post.query().with("author");
      const cloned = (base as any).clone().with("author.team");

      // The clone's added child must not appear on the original.
      const baseQueries = await countQueries(() => base.get());
      const clonedQueries = await countQueries(() => cloned.get());

      expect(baseQueries).toBe(2);
      expect(clonedQueries).toBe(3);
    });
  });

  describe("load() / loadMissing()", () => {
    it("accepts a dot path", async () => {
      const post = await Post.findOrFail("p1");
      await post.load("author.team");

      expect((post as any).author.team.name).toBe("Platform");
    });

    it("accepts a constraining map", async () => {
      const post = await Post.findOrFail("p1");
      await post.load({ comments: (q: any) => q.where("approved", 1) });

      expect((post as any).comments.pluck("id").toArray()).toEqual(["c1"]);
    });

    it("loadMissing skips per segment, not per whole path", async () => {
      const post = await Post.query().where("id", "p1").with("author").first();

      // `author` is already attached; only the `teams` query should run.
      const queries = await countQueries(() => (post as any).loadMissing("author.team"));

      expect(queries).toBe(1);
      expect((post as any).author.team.name).toBe("Platform");
    });

    it("loadMissing still loads a fully missing path", async () => {
      const post = await Post.findOrFail("p1");
      const queries = await countQueries(() => post.loadMissing("author.team"));

      expect(queries).toBe(2);
      expect((post as any).author.team.name).toBe("Platform");
    });
  });

  describe("morphWith", () => {
    it("loads different nested relations per morph type", async () => {
      const notes = await Note.query()
        .with({
          notable: (m: any) =>
            m.morphWith({
              post: ["comments"],
              author: ["team"],
            }),
        })
        .get();

      const onPost = notes.first((n) => n.id === "n1")! as any;
      const onAuthor = notes.first((n) => n.id === "n2")! as any;

      expect(onPost.notable.comments.pluck("id").sort().toArray()).toEqual(["c1", "c2"]);
      expect(onAuthor.notable.team.name).toBe("Platform");
    });

    it("leaves a type with no listed children simply unloaded", async () => {
      const notes = await Note.query()
        .with({ notable: (m: any) => m.morphWith({ author: ["team"] }) })
        .get();

      const onPost = notes.first((n) => n.id === "n1")! as any;
      expect(onPost.notable.relationLoaded("comments")).toBe(false);
      expect(onPost.notable.title).toBe("First");
    });

    it("adds no queries beyond the children themselves", async () => {
      // notes + posts + authors (the morphTo's 2 types)
      const plain = await countQueries(() => Note.query().with("notable").get());
      expect(plain).toBe(3);

      // ...plus one `comments` and one `teams`.
      const nested = await countQueries(() =>
        Note.query()
          .with({ notable: (m: any) => m.morphWith({ post: ["comments"], author: ["team"] }) })
          .get(),
      );
      expect(nested).toBe(5);
    });

    it("supports dot paths inside morphWith", async () => {
      const notes = await Note.query()
        .where("id", "n1")
        .with({ notable: (m: any) => m.morphWith({ post: ["comments.author"] }) })
        .get();

      const note = notes.first()! as any;
      expect(note.notable.comments.first((c: any) => c.id === "c1")!.author.name).toBe("Bo");
    });

    it("applies per-type constraints alongside morphWith", async () => {
      const notes = await Note.query()
        .with({
          notable: (m: any) =>
            m
              .constrain({ post: (q: any) => q.where("title", "Nope") })
              .morphWith({ author: ["team"] }),
        })
        .get();

      // The post-typed note's parent was filtered out entirely...
      expect((notes.first((n) => n.id === "n1")! as any).notable).toBeUndefined();
      // ...while the author-typed one is untouched and still nested.
      expect((notes.first((n) => n.id === "n2")! as any).notable.team.name).toBe("Platform");
    });

    it("still applies morphWith under loadMissing when the morphTo is already loaded", async () => {
      // `node.morphWith` is populated inside the morphTo's own load step,
      // which `loadMissing()` skips for an already-attached relation. The
      // nested loads must survive that skip.
      const note = await Note.query().where("id", "n1").with("notable").first();

      await (note as any).loadMissing({
        notable: (m: any) => m.morphWith({ post: ["comments"] }),
      });

      expect((note as any).notable.comments.count()).toBe(2);
    });

    it("nests plainly under a morphTo when children apply to every type", async () => {
      // Both Post and Author would need the relation; only Post has
      // `comments`, so this asserts the per-type form is the right tool
      // and the plain form is the one that can't express it.
      // A dot path cannot type-check THROUGH a `morphTo`: it has no
      // single related class to continue into (that's the whole point of
      // the per-type `morphWith()` form). The runtime still loads it, so
      // the path is deliberately asserted past the type here.
      const notes = await Note.query()
        .where("notable_type", "post")
        // @ts-expect-error a dot path cannot continue through a morphTo, use morphWith()
        .with("notable.comments")
        .get();

      const n1 = notes.first((n) => n.id === "n1")! as any;
      expect(n1.notable.comments.count()).toBe(2);
    });
  });

  describe("withCount constraints", () => {
    it("counts a filtered subset", async () => {
      const posts = await Post.query()
        .where("id", "p1")
        .withCount({ comments: (q: any) => q.where("approved", 1) })
        .get();

      expect((posts.first()! as any).comments_count).toBe(1);
    });

    it("still supports the plain varargs form", async () => {
      const posts = await Post.query().where("id", "p1").withCount("comments").get();
      expect((posts.first()! as any).comments_count).toBe(2);
    });
  });
});
