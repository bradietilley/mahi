import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { EloquentBuilder } from "../src/eloquent-builder.js";
import { QueryBuilder } from "../src/query-builder.js";
import { belongsTo, hasMany } from "../src/relations.js";
import type { BelongsTo, HasMany } from "../src/markers.js";

interface AuthorAttributes {
  id: string;
  name: string;
  articles: HasMany<Article>;
}

interface ArticleAttributes {
  id: string;
  title: string;
  author_id: string | null;
  parent_id: string | null;
  replies: HasMany<Article>;
  parent: BelongsTo<Article>;
  author: BelongsTo<Author>;
}

/**
 * A self-referential model — `replies` points back at `articles`. The
 * correlated subquery must alias the inner table: without the alias,
 * `whereHas("replies")`/`withCount("replies")` would emit
 * `"articles"."parent_id" = "articles"."id"` and match nothing useful.
 */
class Article extends Model<ArticleAttributes>()({
  table: "articles",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    replies: hasMany(() => Article, { foreignKey: "parent_id" }),
    parent: belongsTo(() => Article, { foreignKey: "parent_id" }),
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
  };
}

class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  timestamps: false,
}) {
  static override relationships = {
    articles: hasMany(() => Article, { foreignKey: "author_id" }),
  };
}

describe("Joins, unions and table aliasing", () => {
  let app: Application;
  let kysely: SqliteDriver["kysely"];
  let table: (name: string) => QueryBuilder<Record<string, any>>;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    kysely = manager.driver().kysely;
    table = (name) => new QueryBuilder<Record<string, any>>(() => manager.driver().kysely, name);

    await kysely.schema
      .createTable("authors")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await kysely.schema
      .createTable("articles")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("author_id", "text")
      .addColumn("parent_id", "text")
      .execute();

    await kysely.schema
      .createTable("article_tag")
      .addColumn("article_id", "text", (col) => col.notNull())
      .addColumn("tag", "text", (col) => col.notNull())
      .addColumn("weight", "integer", (col) => col.notNull().defaultTo(0))
      .execute();

    await Author.create({ id: "a1", name: "Ada" });
    await Author.create({ id: "a2", name: "Grace" });
    await Author.create({ id: "a3", name: "Nobody" });

    // r1/r2 are replies to t1; t2 has no replies; orphan has no author.
    await Article.create({ id: "t1", title: "Root one", author_id: "a1", parent_id: null });
    await Article.create({ id: "t2", title: "Root two", author_id: "a2", parent_id: null });
    await Article.create({ id: "r1", title: "Reply one", author_id: "a2", parent_id: "t1" });
    await Article.create({ id: "r2", title: "Reply two", author_id: "a1", parent_id: "t1" });
    await Article.create({ id: "orphan", title: "No author", author_id: null, parent_id: null });

    await kysely
      .insertInto("article_tag")
      .values([
        { article_id: "t1", tag: "release", weight: 5 },
        { article_id: "t1", tag: "news", weight: 1 },
        { article_id: "t2", tag: "release", weight: 9 },
      ])
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  describe("QueryBuilder.join()", () => {
    it("inner-joins on a simple column pair", async () => {
      const rows = await table("articles")
        .join<{ author_name: string }>("authors", "articles.author_id", "authors.id")
        .select("articles.id as id", "authors.name as author_name")
        .orderBy("id")
        .get();

      expect(rows.map((r) => [r.id, r.author_name])).toEqual([
        ["r1", "Grace"],
        ["r2", "Ada"],
        ["t1", "Ada"],
        ["t2", "Grace"],
      ]);
    });

    it("drops rows with no match (inner) but keeps them with leftJoin", async () => {
      const inner = await table("articles")
        .join("authors", "articles.author_id", "authors.id")
        .select("articles.id as id")
        .get();
      expect(inner.map((r) => r.id).sort()).toEqual(["r1", "r2", "t1", "t2"]);

      const left = await table("articles")
        .leftJoin<{ author_name: string }>("authors", "articles.author_id", "authors.id")
        .select("articles.id as id", "authors.name as author_name")
        .orderBy("id")
        .get();

      expect(left.map((r) => r.id).sort()).toEqual(["orphan", "r1", "r2", "t1", "t2"]);
      expect(left.find((r) => r.id === "orphan")!.author_name).toBeNull();
    });

    it("accepts an on-callback with an extra bound predicate", async () => {
      const rows = await table("articles")
        .join<{ weight: number }>("article_tag", (j) =>
          j.onRef("article_tag.article_id", "=", "articles.id").on("article_tag.tag", "release"),
        )
        .select("articles.id as id", "article_tag.weight as weight")
        .orderBy("id")
        .get();

      expect(rows.map((r) => [r.id, r.weight])).toEqual([
        ["t1", 5],
        ["t2", 9],
      ]);
    });

    it("honors an orOn connector inside the on-callback", async () => {
      const rows = await table("articles")
        .join("article_tag", (j) =>
          j
            .onRef("article_tag.article_id", "=", "articles.id")
            .on("article_tag.tag", "release")
            .orOn("article_tag.tag", "news"),
        )
        .select("articles.id as id", "article_tag.tag as tag")
        .get();

      // `a AND b OR c` folds left-to-right: (article_id = id AND tag = 'release') OR tag = 'news'.
      expect(rows.length).toBeGreaterThan(2);
      expect(rows.some((r) => r.tag === "news")).toBe(true);
    });

    it("cross-joins every row against every row", async () => {
      const rows = await table("articles").crossJoin("authors").select("articles.id as id").get();
      expect(rows.length).toBe(5 * 3);
    });

    it("supports an aliased self-join", async () => {
      const rows = await table("articles as child")
        .join<{ parent_title: string }>("articles as parent", "child.parent_id", "parent.id")
        .select("child.id as id", "parent.title as parent_title")
        .orderBy("id")
        .get();

      expect(rows.map((r) => [r.id, r.parent_title])).toEqual([
        ["r1", "Root one"],
        ["r2", "Root one"],
      ]);
    });

    it("applies joins to count()/exists() as well as get()", async () => {
      const joined = () =>
        table("articles").join("article_tag", (j) =>
          j.onRef("article_tag.article_id", "=", "articles.id").on("article_tag.tag", "release"),
        );

      expect(await joined().count()).toBe(2);
      expect(await joined().exists()).toBe(true);
      expect(
        await table("articles")
          .join("article_tag", (j) =>
            j.onRef("article_tag.article_id", "=", "articles.id").on("article_tag.tag", "nope"),
          )
          .exists(),
      ).toBe(false);
    });

    it("clone() preserves joins independently of the original", async () => {
      const base = table("articles").join("article_tag", "article_tag.article_id", "articles.id");
      const cloned = base.clone().where("article_tag.tag", "release");

      expect(await base.count()).toBe(3);
      expect(await cloned.count()).toBe(2);
    });

    it("refuses to run a write terminal on a joined or aliased query", async () => {
      await expect(
        table("articles").join("authors", "articles.author_id", "authors.id").delete(),
      ).rejects.toThrow(/join\(\) is select-only/);

      await expect(table("articles").alias("a").update({ title: "x" })).rejects.toThrow(
        /alias\(\) is select-only/,
      );
    });
  });

  describe("QueryBuilder.union()", () => {
    it("appends another query's rows, deduplicated", async () => {
      const rows = await table("articles")
        .select("title")
        .where("id", "t1")
        .union((q) => q.table("articles").select("title").whereIn("id", ["t1", "t2"]))
        .get();

      expect(rows.map((r) => r.title).sort()).toEqual(["Root one", "Root two"]);
    });

    it("unionAll keeps duplicates", async () => {
      const rows = await table("articles")
        .select("title")
        .where("id", "t1")
        .unionAll((q) => q.table("articles").select("title").where("id", "t1"))
        .get();

      expect(rows.map((r) => r.title)).toEqual(["Root one", "Root one"]);
    });

    it("orders the combined result, not just the first operand", async () => {
      const rows = await table("articles")
        .select("title")
        .where("id", "t2")
        .union((q) => q.table("articles").select("title").where("id", "t1"))
        .orderBy("title")
        .get();

      expect(rows.map((r) => r.title)).toEqual(["Root one", "Root two"]);
    });
  });

  describe("EloquentBuilder join forwarding", () => {
    it("joins and hydrates the joined columns onto the model instance", async () => {
      const articles = await Article.query()
        .join<{ author_name: string }>("authors", "articles.author_id", "authors.id")
        .select("articles.*", "authors.name as author_name")
        .orderBy("id")
        .get();

      expect(articles.pluck("id").toArray()).toEqual(["r1", "r2", "t1", "t2"]);
      expect((articles.first() as any).author_name).toBe("Grace");
    });

    it("leftJoin keeps unmatched rows", async () => {
      const articles = await Article.query()
        .leftJoin<{ author_name: string }>("authors", "articles.author_id", "authors.id")
        .select("articles.*", "authors.name as author_name")
        .get();

      expect(articles.count()).toBe(5);
    });

    it("unions two model queries", async () => {
      const articles = await Article.query()
        .select("articles.*")
        .where("id", "t1")
        .union((q) => q.table("articles").select("*").where("id", "t2"))
        .orderBy("id")
        .get();

      expect(articles.pluck("id").toArray()).toEqual(["t1", "t2"]);
    });
  });

  describe("self-referential existence queries (regression)", () => {
    it("whereHas() matches only articles that actually have replies", async () => {
      const articles = await Article.query().whereHas("replies").orderBy("id").get();
      expect(articles.pluck("id").toArray()).toEqual(["t1"]);
    });

    it("whereDoesntHave() is its exact complement", async () => {
      const articles = await Article.query().whereDoesntHave("replies").orderBy("id").get();
      expect(articles.pluck("id").toArray()).toEqual(["orphan", "r1", "r2", "t2"]);
    });

    it("withCount() counts each article's own replies", async () => {
      const articles = await Article.query().withCount("replies").orderBy("id").get();

      expect(articles.toArray().map((a) => [a.id, (a as any).replies_count])).toEqual([
        ["orphan", 0],
        ["r1", 0],
        ["r2", 0],
        ["t1", 2],
        ["t2", 0],
      ]);
    });

    it("works through a self-referential belongsTo too", async () => {
      const articles = await Article.query().whereHas("parent").orderBy("id").get();
      expect(articles.pluck("id").toArray()).toEqual(["r1", "r2"]);
    });

    it("still constrains the subquery via the callback", async () => {
      const articles = await Article.query()
        .whereHas("replies", (q) =>
          (q as unknown as EloquentBuilder<ArticleAttributes>).where("title", "Reply two"),
        )
        .get();

      expect(articles.pluck("id").toArray()).toEqual(["t1"]);
    });

    it("leaves non-self-referential relations working unchanged", async () => {
      const authors = await Author.query().whereHas("articles").orderBy("id").get();
      expect(authors.pluck("id").toArray()).toEqual(["a1", "a2"]);

      const counted = await Author.query().withCount("articles").orderBy("id").get();
      expect(counted.toArray().map((a) => [a.id, (a as any).articles_count])).toEqual([
        ["a1", 2],
        ["a2", 2],
        ["a3", 0],
      ]);
    });
  });
});
