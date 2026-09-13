import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";
import { hasManyThrough } from "../src/relations.js";
import type { HasManyThrough } from "../src/markers.js";
import type { GlobalScope } from "../src/global-scope.js";
import type { EloquentBuilder } from "../src/eloquent-builder.js";

interface WidgetAttributes {
  id: string;
  name: string;
  active: boolean;
  updated_at: string | null;
  created_at: string | null;
}
type WidgetTable = WidgetAttributes;

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  casts: { active: Cast.boolean() },
}) {}

interface UntimestampedAttributes {
  id: string;
  name: string;
  active: number;
  updated_at: string | null;
  created_at: string | null;
}

class Untimestamped extends Model<UntimestampedAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("ORM correctness", () => {
  let manager: DatabaseManager;

  beforeEach(async () => {
    const app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("updated_at", "text")
      .addColumn("created_at", "text")
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  describe("static update() applies casts", () => {
    it("accepts a model-shape boolean for a BooleanCast column", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });

      // Without cast-in this reaches better-sqlite3 as a raw boolean and
      // throws "can only bind numbers, strings, bigints, buffers, null".
      await Widget.update("1", { active: false } as any);

      const raw = await manager
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .where("id", "=", "1")
        .executeTakeFirst();
      expect((raw as any).active).toBe(0);
    });

    it("still accepts DB-shape values unchanged", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });
      await Widget.update("1", { name: "Renamed" });

      expect((await Widget.find("1")) as any).toMatchObject({ name: "Renamed" });
    });

    it("hands the cast (DB-shape) payload to lifecycle hooks", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });

      const seen: unknown[] = [];
      Widget.on("updating", (payload) => {
        seen.push((payload as any).active);
      });

      await Widget.update("1", { active: false } as any);
      expect(seen).toEqual([0]);
    });
  });

  describe("builder update() stamps updated_at", () => {
    it("sets updated_at on a timestamped model", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });
      await manager
        .driver()
        .kysely.updateTable("widgets")
        .set({ updated_at: null })
        .where("id", "=", "1")
        .execute();

      await Widget.query().where("id", "1").update({ name: "Renamed" });

      const raw: any = await manager
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .where("id", "=", "1")
        .executeTakeFirst();
      expect(raw.updated_at).not.toBeNull();
    });

    it("does not overwrite an explicitly supplied updated_at", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });

      await Widget.query()
        .where("id", "1")
        .update({ name: "Renamed", updated_at: "2020-01-01T00:00:00.000Z" });

      const raw: any = await manager
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .where("id", "=", "1")
        .executeTakeFirst();
      expect(raw.updated_at).toBe("2020-01-01T00:00:00.000Z");
    });

    it("leaves updated_at alone on a model with timestamps disabled", async () => {
      await Untimestamped.create({ id: "1", name: "Sprocket", active: 1, updated_at: null });
      await Untimestamped.query().where("id", "1").update({ name: "Renamed" });

      const raw: any = await manager
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .where("id", "=", "1")
        .executeTakeFirst();
      expect(raw.updated_at).toBeNull();
    });
  });

  describe("booleans are bindable on SQLite", () => {
    it("where() accepts a raw boolean", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });
      await Widget.create({ id: "2", name: "Cog", active: false });

      // better-sqlite3 rejects a JS boolean binding outright; the driver
      // boundary coerces it to 1/0 first.
      const rows = await manager
        .driver()
        .kysely.selectFrom("widgets")
        .selectAll()
        .where("active", "=", true as any)
        .execute();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).id).toBe("1");
    });

    it("a boolean survives a builder where()", async () => {
      await Widget.create({ id: "1", name: "Sprocket", active: true });

      const found = await Widget.query()
        .where("active", true as any)
        .first();
      expect(found).toBeTruthy();
    });
  });

  describe("firstOrCreate()/updateOrCreate() recover from a unique collision", () => {
    it("firstOrCreate() returns the winning row instead of throwing", async () => {
      // Simulate losing the race: the row appears between the read and
      // the insert, so the insert collides on the primary key.
      const original = Widget.matching.bind(Widget);
      let firstCall = true;
      (Widget as any).matching = (attributes: Record<string, any>) => {
        const builder = original(attributes as any);

        if (firstCall) {
          firstCall = false;
          const realFirst = builder.first.bind(builder);
          (builder as any).first = async () => {
            await manager
              .driver()
              .kysely.insertInto("widgets")
              .values({ id: "1", name: "Winner", active: 1 })
              .execute();

            return undefined;
          };
          void realFirst;
        }

        return builder;
      };

      try {
        const widget = await Widget.firstOrCreate({ id: "1" }, { name: "Loser" } as any);
        expect((widget as any).name).toBe("Winner");
      } finally {
        (Widget as any).matching = original;
      }
    });

    it("rethrows a unique violation the re-read can't explain", async () => {
      await manager
        .driver()
        .kysely.schema.createIndex("widgets_name_unique")
        .on("widgets")
        .column("name")
        .unique()
        .execute();

      await Widget.create({ id: "1", name: "Taken", active: true });

      // Collides on `name`, not on the `id` we matched by, the re-read
      // finds nothing, so the original error must surface rather than
      // being swallowed.
      await expect(Widget.firstOrCreate({ id: "2" }, { name: "Taken" } as any)).rejects.toThrow(
        /UNIQUE constraint failed/,
      );
    });

    it("rethrows a non-unique constraint error untouched", async () => {
      await expect(Widget.firstOrCreate({ id: "2" }, { name: null } as any)).rejects.toThrow(
        /NOT NULL constraint failed/,
      );
    });

    it("updateOrCreate()'s create path fires create events once, with no spurious update", async () => {
      // The recovery path applies `values` to whichever row won, which on
      // the ordinary (uncontended) path is the one we just inserted, so
      // the follow-up `updateInstance()` must no-op rather than emitting a
      // second round of update events for a row nothing changed.
      const fired: string[] = [];

      for (const event of [
        "saving",
        "creating",
        "created",
        "updating",
        "updated",
        "saved",
      ] as const) {
        Widget.on(event, () => {
          fired.push(event);
        });
      }

      const widget = await Widget.updateOrCreate({ id: "1" }, { name: "New", active: true } as any);

      expect((widget as any).name).toBe("New");
      expect(fired).toEqual(["saving", "creating", "created", "saved"]);
    });
  });

  describe("paginate() clamps page/perPage", () => {
    beforeEach(async () => {
      for (const id of ["1", "2", "3"]) {
        await Widget.create({ id, name: `W${id}`, active: true });
      }
    });

    it("page 0 is treated as page 1 rather than a negative OFFSET", async () => {
      const result = await Widget.paginate(0, 2);
      expect(result.page).toBe(1);
      expect(result.data.length).toBe(2);
    });

    it("a negative page is treated as page 1", async () => {
      const result = await Widget.paginate(-5, 2);
      expect(result.page).toBe(1);
      expect(result.data.length).toBe(2);
    });

    it("perPage below 1 is clamped to 1", async () => {
      const result = await Widget.paginate(1, 0);
      expect(result.perPage).toBe(1);
      expect(result.data.length).toBe(1);
      expect(result.total).toBe(3);
    });

    it("simplePaginate() clamps the same way", async () => {
      const result = await Widget.simplePaginate(0, 2);
      expect(result.page).toBe(1);
      expect(result.data.length).toBe(2);
      expect(result.hasMore).toBe(true);
    });

    it("a NaN page (a junk query param) falls back to page 1", async () => {
      const result = await Widget.paginate(Number.NaN, 2);
      expect(result.page).toBe(1);
    });
  });

  describe("paginate() totals for grouped/distinct queries", () => {
    beforeEach(async () => {
      await Widget.create({ id: "1", name: "A", active: true });
      await Widget.create({ id: "2", name: "A", active: true });
      await Widget.create({ id: "3", name: "B", active: false });
    });

    it("reports the number of GROUPS, not rows", async () => {
      const result = await paginateGrouped();
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
    });

    async function paginateGrouped() {
      const { paginate } = await import("../src/pagination/length-aware-paginator.js");
      const builder = Widget.query().groupBy("name") as unknown as EloquentBuilder<WidgetTable>;

      return paginate(builder, 1, 10);
    }
  });
});

describe("through-relation global scopes", () => {
  interface CountryAttributes {
    id: string;
    name: string;
    posts: HasManyThrough<Post>;
  }
  interface UserAttributes {
    id: string;
    country_id: string;
    deleted_at: string | null;
  }
  interface PostAttributes {
    id: string;
    user_id: string;
    title: string;
  }

  class User extends Model<UserAttributes>()({
    table: "users",
    primaryKey: "id",
    timestamps: false,
    softDeletes: true,
  }) {}

  class Post extends Model<PostAttributes>()({
    table: "posts",
    primaryKey: "id",
    timestamps: false,
  }) {}

  class Country extends Model<CountryAttributes>()({
    table: "countries",
    primaryKey: "id",
    timestamps: false,
  }) {
    static override relationships = {
      posts: hasManyThrough(() => Post, {
        through: () => User,
        firstKey: "country_id",
        secondKey: "user_id",
      }),
    };
  }

  let manager: DatabaseManager;

  beforeEach(async () => {
    const app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const kysely = manager.driver().kysely;
    await kysely.schema
      .createTable("countries")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await kysely.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("country_id", "text", (col) => col.notNull())
      .addColumn("deleted_at", "text")
      .execute();
    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("user_id", "text", (col) => col.notNull())
      .addColumn("title", "text", (col) => col.notNull())
      .execute();

    await Country.create({ id: "nz", name: "New Zealand" });
    await User.create({ id: "u1", country_id: "nz", deleted_at: null });
    await User.create({ id: "u2", country_id: "nz", deleted_at: null });
    await Post.create({ id: "p1", user_id: "u1", title: "Kept" });
    await Post.create({ id: "p2", user_id: "u2", title: "Orphaned" });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("a soft-deleted THROUGH row stops linking its related rows", async () => {
    await User.delete("u2");

    const country = (await Country.find("nz"))!;
    const posts = await Country.hasManyThrough(
      Post,
      country.toObject() as any,
      {
        through: () => User,
        firstKey: "country_id",
        secondKey: "user_id",
      } as any,
    ).get();

    expect(posts.toArray().map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("the batched eager loader agrees with the non-batched helper", async () => {
    await User.delete("u2");

    const countries = await Country.query().with("posts").get();
    const posts = (countries.first() as any).posts;

    expect(posts.toArray().map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("without a soft delete, both through rows still link", async () => {
    const countries = await Country.query().with("posts").get();
    const posts = (countries.first() as any).posts;

    expect(
      posts
        .toArray()
        .map((p: any) => p.id)
        .sort(),
    ).toEqual(["p1", "p2"]);
  });
});

describe("global scopes other than soft deletes still gate persistence correctly", () => {
  interface RowShape {
    id: string;
    tenant_id: string;
    name: string;
  }

  class TenantScope implements GlobalScope {
    apply(builder: EloquentBuilder<any>): void {
      builder.where("tenant_id", "acme");
    }
  }

  class Doc extends Model<RowShape>()({
    table: "docs",
    primaryKey: "id",
    timestamps: false,
  }) {
    static override scopes: GlobalScope[] = [new TenantScope()];
  }

  let manager: DatabaseManager;

  beforeEach(async () => {
    const app = new Application();
    manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("docs")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("tenant_id", "text", (col) => col.notNull())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await manager
      .driver()
      .kysely.insertInto("docs")
      .values([{ id: "1", tenant_id: "acme", name: "Ours" }])
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("save() persists even when the update itself changes the scoped column", async () => {
    const doc = (await Doc.find("1"))!;
    (doc as any).tenant_id = "other";
    await doc.save();

    const raw: any = await manager
      .driver()
      .kysely.selectFrom("docs")
      .selectAll()
      .where("id", "=", "1")
      .executeTakeFirst();
    expect(raw.tenant_id).toBe("other");
  });

  it("reads still honour the scope", async () => {
    await manager
      .driver()
      .kysely.insertInto("docs")
      .values([{ id: "2", tenant_id: "other", name: "Theirs" }])
      .execute();

    expect((await Doc.all()).length).toBe(1);
  });
});
