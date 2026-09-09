/**
 * Post-save change tracking — `getChanges()`/`wasChanged()`/
 * `wasRecentlyCreated`, the cast-aware `getOriginal()`/`getRawOriginal()`
 * split, `originalIsEquivalent()`, and `discardChanges()`.
 *
 * The pre-save half (`getDirty()`/`isDirty()`) is covered by
 * `model-instances.test.ts`; this file pins the window that opens where
 * that one closes. The distinction matters because `save()` calls
 * `syncOriginal()`, which destroys the evidence of what it just wrote —
 * an `updated` observer that wants to react to one specific transition
 * (`order.wasChanged("status")`) has no other way to know.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { DateTime } from "@mahi/datetime";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model, type WritableAttributes } from "../src/model.js";
import { Cast } from "../src/casts.js";

// Declared model-side: a cast column's type here is what you read BACK
// off an instance (`published` is a `boolean`, not the DB's 0/1), and the
// cast's own model type has to equal it.
interface PostAttributes {
  id: string;
  title: string;
  body: string;
  status: string;
  published: boolean;
  price: string;
  views: number;
  meta: Meta | null;
  published_at: DateTime | null;
  created_at: string | null;
  updated_at: string | null;
}

interface Meta {
  tags?: string[];
  featured?: boolean;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: true,
  casts: {
    published: Cast.boolean(),
    price: Cast.decimal(2),
    meta: Cast.json<Meta>(),
    published_at: Cast.datetime(),
  },
}) {}

interface WidgetAttributes {
  id: string;
  name: string;
  deleted_at: string | null;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
  softDeletes: true,
}) {}

/**
 * Overrides are typed with the *writable* attribute shape, not
 * `Partial<PostAttributes>`: several tests below deliberately seed a
 * column with its database-facing value (`published: 1`, a JSON string for
 * `meta`) to exercise the read-side casts, which is exactly the leniency
 * `Cast.toDatabaseType()` documents.
 */
type PostOverrides = Partial<WritableAttributes<PostAttributes, typeof Post>>;

/** The attribute set every fixture row starts from. */
function postAttributes(overrides: PostOverrides = {}): PostAttributes {
  return {
    id: "1",
    title: "Hello",
    body: "World",
    status: "draft",
    published: false,
    price: "10.00",
    views: 1,
    meta: null,
    published_at: null,
    ...overrides,
  } as PostAttributes;
}

/**
 * A saved post, read back so it's in the same state a finder returns.
 *
 * The clock is advanced by a second afterwards: `updated_at` stamping is
 * millisecond-resolution, and an in-memory SQLite test completes a
 * create-then-save well inside one — leaving the "new" timestamp equal to
 * the old one, which is correctly reported as *not* changed and would make
 * every `updated_at` assertion below depend on how fast the machine is.
 */
async function seedPost(overrides: PostOverrides = {}): Promise<Post> {
  const attributes = postAttributes(overrides);
  await Post.create(attributes);
  const post = (await Post.find(attributes.id))! as unknown as Post;
  DateTime.setTestNow(DateTime.now("UTC").addSeconds(1));

  return post;
}

describe("Model change tracking", () => {
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
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("status", "text", (col) => col.notNull())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("price", "text", (col) => col.notNull())
      .addColumn("views", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("meta", "text")
      .addColumn("published_at", "text")
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text")
      .execute();

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("deleted_at", "text")
      .execute();
  });

  afterEach(() => {
    DateTime.setTestNow(null);
    clearCurrentApp();
  });

  describe("wasRecentlyCreated", () => {
    it("is true after create(), with no changes recorded", async () => {
      const post = await Post.create(postAttributes());

      expect(post.wasRecentlyCreated).toBe(true);
      expect(post.getChanges()).toEqual({});
      expect(post.wasChanged()).toBe(false);
    });

    it("is false on a hydrated instance and on a finder result", async () => {
      await seedPost();

      expect(Post.hydrate({ id: "1", title: "x" }).wasRecentlyCreated).toBe(false);
      expect((await Post.find("1"))!.wasRecentlyCreated).toBe(false);
    });

    it("is false on a new, unsaved instance", () => {
      expect(new Post({ id: "1", title: "Hello" }).wasRecentlyCreated).toBe(false);
    });

    it("survives a later update of the same instance", async () => {
      const post = (await Post.create(postAttributes())) as unknown as Post;

      post.title = "Changed";
      await post.save();

      expect(post.wasRecentlyCreated).toBe(true);
      expect(post.wasChanged("title")).toBe(true);
    });

    it("distinguishes the firstOrCreate() branches", async () => {
      const created = await Post.firstOrCreate({ id: "1" }, postAttributes());
      expect(created.wasRecentlyCreated).toBe(true);

      const found = await Post.firstOrCreate({ id: "1" }, {
        title: "Ignored",
      } as Partial<PostAttributes>);
      expect(found.wasRecentlyCreated).toBe(false);
      expect(found.title).toBe("Hello");
    });

    it("reports an updateOrCreate() that updated as changed, not created", async () => {
      await seedPost();

      const post = (await Post.updateOrCreate({ id: "1" }, {
        status: "published",
      } as Partial<PostAttributes>)) as unknown as Post;

      expect(post.wasRecentlyCreated).toBe(false);
      expect(post.wasChanged()).toBe(true);
      expect(post.wasChanged("status")).toBe(true);
    });

    it("is set through markPersisted(), the seam Factory's batched insert uses", () => {
      // Factory writes its rows itself rather than going through `save()`,
      // so `markPersisted()` has to land the instance in the same state
      // `save()`'s insert branch does — otherwise a factory-made model
      // would report itself as never created.
      const post = new Post({ id: "9", title: "T", body: "B", status: "draft" });
      post.markPersisted();

      expect(post.wasRecentlyCreated).toBe(true);
      expect(post.exists()).toBe(true);
      expect(post.getChanges()).toEqual({});
    });
  });

  describe("getChanges() / wasChanged()", () => {
    it("records exactly the columns the UPDATE wrote, plus the stamped updated_at", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();

      expect(Object.keys(post.getChanges()).sort()).toEqual(["title", "updated_at"]);
      expect(post.getChanges().title).toBe("Changed");
      expect(post.wasChanged()).toBe(true);
      expect(post.wasChanged("title")).toBe(true);
      expect(post.wasChanged("body")).toBe(false);
      expect(post.isDirty()).toBe(false);
    });

    it("treats a key list as OR, matching Laravel", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();

      expect(post.wasChanged(["body", "title"])).toBe(true);
      expect(post.wasChanged(["body", "status"])).toBe(false);
      expect(post.wasChanged([])).toBe(false);
    });

    it("is empty before any save", () => {
      const post = new Post({ id: "1", title: "Hello" });
      expect(post.getChanges()).toEqual({});
      expect(post.wasChanged()).toBe(false);
    });

    it("returns a copy — mutating it cannot corrupt the instance's record", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();

      const changes = post.getChanges();
      delete changes.title;

      expect(post.wasChanged("title")).toBe(true);
    });

    it("a no-op save() leaves the previous save's changes intact", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();
      await post.save(); // nothing dirty — returns early, no UPDATE

      expect(post.wasChanged("title")).toBe(true);
    });

    it("a second real save() replaces the changes rather than accumulating them", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();
      post.body = "Rewritten";
      await post.save();

      expect(post.wasChanged("body")).toBe(true);
      expect(post.wasChanged("title")).toBe(false);
    });

    it("getChangedAttributes() applies casts, getChanges() does not", async () => {
      const post = await seedPost();
      post.published = true;
      await post.save();

      expect(post.getChanges().published).toBe(1);
      expect(post.getChangedAttributes().published).toBe(true);
    });

    it("refresh() clears changes and wasRecentlyCreated", async () => {
      const post = (await Post.create(postAttributes())) as unknown as Post;
      post.title = "Changed";
      await post.save();

      await post.refresh();

      expect(post.getChanges()).toEqual({});
      expect(post.wasChanged()).toBe(false);
      expect(post.wasRecentlyCreated).toBe(false);
    });

    it("restore() records only the deleted_at column it wrote", async () => {
      await Widget.create({ id: "1", name: "Sprocket", deleted_at: null });
      await Widget.delete("1");
      const widget = (await Widget.withTrashed().where("id", "1").first())! as unknown as Widget;

      await widget.restore();

      expect(widget.getChanges()).toEqual({ deleted_at: null });
      expect(widget.wasChanged("deleted_at")).toBe(true);
      expect(widget.trashed()).toBe(false);
    });
  });

  describe("model events", () => {
    it("gives updating isDirty() and updated wasChanged() for the same transition", async () => {
      const seen: string[] = [];
      Post.on("updating", (p) => {
        const post = p as unknown as Post;
        seen.push(`updating:dirty=${post.isDirty("status")}:changed=${post.wasChanged("status")}`);
      });
      Post.on("updated", (p) => {
        const post = p as unknown as Post;
        seen.push(`updated:changed=${post.wasChanged("status")}`);
      });

      const post = await seedPost();
      post.status = "published";
      await post.save();

      expect(seen).toEqual(["updating:dirty=true:changed=false", "updated:changed=true"]);
    });

    it("lets an updated hook read the value that was written over — the acceptance case", async () => {
      const transitions: string[] = [];
      Post.on("updated", (p) => {
        const post = p as unknown as Post;

        if (post.wasChanged("status")) {
          transitions.push(`${String(post.getOriginal("status"))} → ${String(post.status)}`);
        }
      });

      const post = await seedPost();
      post.status = "published";
      await post.save();

      // The whole point of syncing the snapshot AFTER the events: both
      // sides of the transition are readable from inside the hook.
      expect(transitions).toEqual(["draft → published"]);
      // ...and the snapshot has caught up by the time save() returns.
      expect(post.getOriginal("status")).toBe("published");
      expect(post.isDirty()).toBe(false);
    });

    it("does not fire updated at all when nothing changed", async () => {
      const post = await seedPost();
      const seen: string[] = [];
      Post.on("updated", () => {
        seen.push("updated");
      });

      await post.save();

      expect(seen).toEqual([]);
      expect(post.wasChanged()).toBe(false);
    });

    it("gives created hooks wasRecentlyCreated with no changes", async () => {
      const seen: string[] = [];
      Post.on("created", (p) => {
        const post = p as unknown as Post;
        seen.push(
          `created:recent=${post.wasRecentlyCreated}:changed=${post.wasChanged()}` +
            `:dirty=${post.isDirty()}`,
        );
      });

      await Post.create(postAttributes());

      expect(seen).toEqual(["created:recent=true:changed=false:dirty=false"]);
    });
  });

  describe("getOriginal() vs getRawOriginal()", () => {
    it("casts on getOriginal() and does not on getRawOriginal()", async () => {
      const post = await seedPost({ meta: JSON.stringify({ tags: ["a"] }), published: 1 });

      expect(post.getOriginal("meta")).toEqual({ tags: ["a"] });
      expect(post.getRawOriginal("meta")).toBe('{"tags":["a"]}');
      expect(post.getOriginal("published")).toBe(true);
      expect(post.getRawOriginal("published")).toBe(1);
    });

    it("keeps reporting the pre-change value while an attribute is dirty", async () => {
      const post = await seedPost();
      post.status = "published";

      expect(post.getOriginal("status")).toBe("draft");
      expect(post.status).toBe("published");
    });

    it("returns whole snapshots — cast and raw", async () => {
      const post = await seedPost({ published: 1 });

      expect(post.getOriginal().published).toBe(true);
      expect(post.getRawOriginal().published).toBe(1);
    });

    it("passes null through both", async () => {
      const post = await seedPost();

      expect(post.getOriginal("meta")).toBeNull();
      expect(post.getRawOriginal("meta")).toBeNull();
    });
  });

  describe("originalIsEquivalent()", () => {
    it("treats a JSON object with equal contents as unchanged", async () => {
      const post = await seedPost({ meta: JSON.stringify({ tags: ["a", "b"], featured: true }) });

      post.meta = { tags: ["a", "b"], featured: true };

      expect(post.isDirty("meta")).toBe(false);
      expect(post.getDirty()).toEqual({});
    });

    it("ignores JSON key order", async () => {
      const post = await seedPost({ meta: JSON.stringify({ featured: true, tags: ["a"] }) });

      post.meta = { tags: ["a"], featured: true };

      expect(post.isDirty("meta")).toBe(false);
    });

    it("sees a JSON object with different contents as changed", async () => {
      const post = await seedPost({ meta: JSON.stringify({ tags: ["a"] }) });

      post.meta = { tags: ["a", "b"] };

      expect(post.isDirty("meta")).toBe(true);
    });

    it("treats the same instant re-assigned as unchanged, across spellings", async () => {
      const post = await seedPost({ published_at: "2026-09-02T07:31:37.000Z" });

      post.published_at = DateTime.fromISO("2026-09-02T07:31:37.000Z", "UTC");
      expect(post.isDirty("published_at")).toBe(false);

      // MySQL's space-separated spelling of the same moment.
      post.setRawAttribute("published_at", "2026-09-02 07:31:37.000");
      expect(post.isDirty("published_at")).toBe(false);
    });

    it("sees a different instant as changed", async () => {
      const post = await seedPost({ published_at: "2026-09-02T07:31:37.000Z" });

      post.published_at = DateTime.fromISO("2026-09-02T07:31:38.000Z", "UTC");

      expect(post.isDirty("published_at")).toBe(true);
    });

    it("treats an auto-managed timestamp re-spelled as unchanged", async () => {
      const post = await seedPost();
      const isoNow = post.getRawOriginal("updated_at") as string;

      post.setRawAttribute("updated_at", isoNow.replace("T", " ").replace("Z", ""));

      expect(post.isDirty("updated_at")).toBe(false);
    });

    it("treats a numeric string round-trip as unchanged (MySQL/PG return strings)", async () => {
      const post = await seedPost();
      // What a driver hands back for an INTEGER/BIGINT column as text.
      post.setRawAttribute("views", "1");
      post.syncOriginal();
      post.views = 1;

      expect(post.isDirty("views")).toBe(false);
    });

    it("still sees a real numeric change", async () => {
      const post = await seedPost();
      post.views = 2;

      expect(post.isDirty("views")).toBe(true);
    });

    it("does not treat a boolean as equivalent to its numeric spelling on an uncast column", async () => {
      const post = await seedPost();
      post.setRawAttribute("views", true);

      expect(post.isDirty("views")).toBe(true);
    });

    it("normalises through a decimal cast", async () => {
      const post = await seedPost({ price: "10.00" });

      // Assigning the cast's DB type works at runtime (`setAttribute()`
      // runs `toDatabaseType`, which takes `ModelType | DbType`) and is
      // documented in docs/models/README.md, but is not expressible in the
      // type: attribute properties come from a mapped type, and a mapped
      // type cannot give a property a wider write type than its read type.
      // `create()`/`update()` take the lenient `WritableAttributes` shape;
      // only direct property assignment has this gap.
      // @ts-expect-error see above — DB-typed write, model-typed property
      post.price = 10;

      expect(post.isDirty("price")).toBe(false);
    });

    it("counts a key missing from the snapshot as changed", () => {
      const post = new Post({ id: "1", title: "Hello" });

      expect(post.originalIsEquivalent("title")).toBe(false);
      expect(post.isDirty("title")).toBe(true);
    });

    it("counts a null↔value transition as changed in both directions", async () => {
      const post = await seedPost({ meta: null });
      post.meta = { tags: [] };
      expect(post.isDirty("meta")).toBe(true);

      const other = await seedPost({
        id: "2",
        meta: JSON.stringify({ tags: [] }),
      } as Partial<PostAttributes>);
      other.meta = null as never;
      expect(other.isDirty("meta")).toBe(true);
    });

    it("reports a value a cast cannot decode as changed rather than throwing", async () => {
      const post = await seedPost({ meta: "not json{" });

      post.setRawAttribute("meta", "also not json{");

      expect(() => post.isDirty("meta")).not.toThrow();
      expect(post.isDirty("meta")).toBe(true);
    });

    it("does not rewrite unchanged columns on save", async () => {
      const post = await seedPost({ meta: JSON.stringify({ tags: ["a"] }) });
      post.meta = { tags: ["a"] };
      post.title = "Changed";
      await post.save();

      expect(Object.keys(post.getChanges()).sort()).toEqual(["title", "updated_at"]);
    });
  });

  describe("discardChanges()", () => {
    it("restores the snapshot values and leaves the instance clean", async () => {
      const post = await seedPost();
      post.title = "Changed";
      post.status = "published";

      post.discardChanges();

      expect(post.title).toBe("Hello");
      expect(post.status).toBe("draft");
      expect(post.isDirty()).toBe(false);
    });

    it("drops an attribute that was never in the snapshot", () => {
      const post = new Post({ id: "1", title: "Hello" });
      post.discardChanges();

      expect(post.getRawAttribute("title")).toBeUndefined();
      expect(post.isDirty()).toBe(false);
    });

    it("clears the post-save changes record", async () => {
      const post = await seedPost();
      post.title = "Changed";
      await post.save();

      post.discardChanges();

      expect(post.wasChanged()).toBe(false);
      expect(post.getChanges()).toEqual({});
    });

    it("returns the instance for chaining", async () => {
      const post = await seedPost();
      expect(post.discardChanges()).toBe(post);
    });

    it("makes a subsequent save() a no-op", async () => {
      const post = await seedPost();
      post.title = "Changed";
      post.discardChanges();
      await post.save();

      const reread = await Post.find("1");
      expect(reread!.title).toBe("Hello");
    });
  });

  describe("getDirtyAttributes()", () => {
    it("is the cast-aware view of getDirty()", async () => {
      const post = await seedPost();
      post.published = true;
      post.meta = { tags: ["x"] };

      expect(post.getDirty()).toEqual({ published: 1, meta: '{"tags":["x"]}' });
      expect(post.getDirtyAttributes()).toEqual({ published: true, meta: { tags: ["x"] } });
    });
  });

  describe("isDirty() key lists", () => {
    it("treats a key list as OR", async () => {
      const post = await seedPost();
      post.title = "Changed";

      expect(post.isDirty(["body", "title"])).toBe(true);
      expect(post.isDirty(["body", "status"])).toBe(false);
      expect(post.isClean(["body", "status"])).toBe(true);
      expect(post.isDirty([])).toBe(false);
    });
  });
});
