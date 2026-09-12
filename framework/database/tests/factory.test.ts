import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Factory } from "../src/factory.js";
import { Cast } from "../src/casts.js";

interface WidgetAttributes {
  id: string;
  name: string;
  active: number;
}
type WidgetTable = WidgetAttributes;

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {
  static override factory(): WidgetFactory {
    return new WidgetFactory();
  }
}

class WidgetFactory extends Factory<typeof Widget> {
  protected model = Widget;

  protected definition(): WidgetAttributes {
    return {
      id: randomUUID(),
      name: `Widget ${Math.random().toString(36).slice(2, 8)}`,
      active: 1,
    };
  }

  inactive(): this {
    return this.state({ active: 0 });
  }
}

describe("Factory", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("widgets")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
      .execute();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("make() returns an array of valid row(s) without touching the DB", async () => {
    const rows = await new WidgetFactory().make();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: 1 });
    expect(rows[0]!.id).toBeTruthy();

    expect((await Widget.all()).length).toBe(0);
  });

  it("makeOne() returns a single row without touching the DB", async () => {
    const row = await new WidgetFactory().makeOne();
    expect(row).toMatchObject({ active: 1 });
    expect(row.id).toBeTruthy();

    expect((await Widget.all()).length).toBe(0);
  });

  it("create() inserts and returns an array of row(s)", async () => {
    const rows = await new WidgetFactory().create();
    expect(rows).toBeInstanceOf(Array);
    expect(rows).toHaveLength(1);

    const found = await Widget.find(rows[0]!.id);
    expect(found).toMatchObject({ name: rows[0]!.name });
  });

  it("createOne() inserts and returns a single row", async () => {
    const row = await new WidgetFactory().createOne();
    expect(row).not.toBeInstanceOf(Array);

    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ name: row.name });
  });

  it("overrides merge over definition() defaults", async () => {
    const row = await new WidgetFactory().createOne({ active: 0 });
    expect(row.active).toBe(0);

    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ active: 0 });
  });

  it("times(n).create() inserts exactly n rows in one batch", async () => {
    const rows = await new WidgetFactory().times(5).create();
    expect(rows).toHaveLength(5);

    expect((await Widget.all()).length).toBe(5);
  });

  it("times(n).make() returns n in-memory rows without touching the DB", async () => {
    const rows = await new WidgetFactory().times(3).make();
    expect(rows).toHaveLength(3);
  });

  it("createOne()/makeOne() ignore times()", async () => {
    const row = await new WidgetFactory().times(5).makeOne();
    expect(row).not.toBeInstanceOf(Array);
  });

  it("state() layers a partial override on top of definition()", async () => {
    const row = await new WidgetFactory().inactive().makeOne();
    expect(row.active).toBe(0);
  });

  it("state() accepts a resolver receiving the attributes built so far", async () => {
    const row = await new WidgetFactory()
      .state((attrs) => ({ name: `${attrs.name}-suffixed` }))
      .makeOne();
    expect(row.name.endsWith("-suffixed")).toBe(true);
  });

  it("multiple state() calls compose in call order, explicit overrides win last", async () => {
    const row = await new WidgetFactory()
      .state({ active: 0 })
      .state({ active: 1 })
      .makeOne({ name: "explicit" });
    expect(row.active).toBe(1);
    expect(row.name).toBe("explicit");
  });

  it("afterMaking() runs on make()/makeOne(), even without a DB write", async () => {
    let called = 0;
    const row = await new WidgetFactory()
      .afterMaking((w) => {
        called++;
        w.name = `${w.name}-made`;
      })
      .makeOne();

    expect(called).toBe(1);
    expect(row.name.endsWith("-made")).toBe(true);
    expect((await Widget.all()).length).toBe(0);
  });

  it("afterMaking() runs once per row for times(n)", async () => {
    let called = 0;
    const rows = await new WidgetFactory()
      .times(3)
      .afterMaking(() => {
        called++;
      })
      .make();

    expect(called).toBe(3);
    expect(rows).toHaveLength(3);
  });

  it("afterCreating() runs after create()/createOne() inserts the row", async () => {
    const created: string[] = [];
    const row = await new WidgetFactory()
      .afterCreating((w) => {
        created.push(w.id);
      })
      .createOne();

    expect(created).toEqual([row.id]);
  });

  it("afterCreating() does not run for make()/makeOne()", async () => {
    let called = false;
    await new WidgetFactory()
      .afterCreating(() => {
        called = true;
      })
      .makeOne();

    expect(called).toBe(false);
  });

  it("Model.factory() resolves the model's declared Factory", async () => {
    const row = await Widget.factory().createOne();
    const found = await Widget.find(row.id);
    expect(found).toMatchObject({ name: row.name });
  });

  it("Model.factory() throws for models without a factory() override", async () => {
    class Gadget extends Model<WidgetAttributes>()({
      table: "gadgets",
      primaryKey: "id",
    }) {}

    expect(() => Gadget.factory()).toThrow();
  });

  it("create()/createOne() fire creating/created Model events by default", async () => {
    const fired: string[] = [];
    Widget.on("creating", () => {
      fired.push("creating");
    });
    Widget.on("created", (row) => {
      fired.push(`created:${(row as WidgetTable).id}`);
    });

    const row = await new WidgetFactory().createOne();

    expect(fired).toEqual(["creating", `created:${row.id}`]);
  });

  it("times(n).create() fires creating/created once per row, in one batch insert", async () => {
    const fired: string[] = [];
    Widget.on("created", (row) => {
      fired.push((row as WidgetTable).id);
    });

    const rows = await new WidgetFactory().times(3).create();

    expect(fired.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("createQuietly() inserts normally but suppresses Model events", async () => {
    let called = false;
    Widget.on("created", () => {
      called = true;
    });

    const rows = await new WidgetFactory().createQuietly();

    expect(rows).toHaveLength(1);
    expect(await Widget.find(rows[0]!.id)).toMatchObject({ name: rows[0]!.name });
    expect(called).toBe(false);
  });

  it("createOneQuietly() inserts normally but suppresses Model events", async () => {
    let called = false;
    Widget.on("created", () => {
      called = true;
    });

    const row = await new WidgetFactory().createOneQuietly();

    expect(await Widget.find(row.id)).toMatchObject({ name: row.name });
    expect(called).toBe(false);
  });

  it("createQuietly() still runs afterCreating callbacks (a Factory hook, not a Model event)", async () => {
    const created: string[] = [];

    const rows = await new WidgetFactory()
      .afterCreating((w) => {
        created.push(w.id);
      })
      .createQuietly();

    expect(created).toEqual([rows[0]!.id]);
  });
});

/**
 * A `definition()` is typed as the model shape, so a factory author
 * writes `published: true` and `meta: { … }` — and those must reach the
 * database as `1` and `'{"a":1}'`.
 *
 * The build path used to go through `setRawAttributes()`, which skips
 * casts entirely, so both bound as a raw boolean/object: `create()` threw
 * on SQLite and MySQL and silently coerced on Postgres. It builds through
 * `forceFill()` now (casts applied, `fillable`/`guarded` deliberately
 * bypassed — a factory is trusted fixture code).
 */
describe("Factory applies the model's casts", () => {
  let app: Application;

  interface CastedAttributes {
    id: string;
    published: boolean;
    meta: Record<string, unknown> | null;
    note: string | null;
  }

  class Casted extends Model<CastedAttributes>()({
    table: "casted",
    primaryKey: "id",
    timestamps: false,
    keyType: "uuid",
    casts: { published: Cast.boolean(), meta: Cast.json<Record<string, unknown>>() },
  }) {}

  class CastedFactory extends Factory<typeof Casted> {
    protected model = Casted;
    protected definition(): Record<string, any> {
      // Model-shape values, exactly as the type invites.
      return { published: true, meta: { a: 1 }, note: null };
    }
  }

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    await manager
      .driver()
      .kysely.schema.createTable("casted")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("published", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("meta", "text")
      .addColumn("note", "text")
      .execute();
  });

  afterEach(() => clearCurrentApp());

  it("create() writes the cast DB shape", async () => {
    await new CastedFactory().createOne();

    const raw = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("casted")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(raw.published).toBe(1);
    expect(raw.meta).toBe('{"a":1}');
  });

  it("make() reads back through the casts", async () => {
    const row = await new CastedFactory().makeOne();
    expect(row.published).toBe(true);
    expect(row.meta).toEqual({ a: 1 });
  });

  it("casts an override the same way as a definition value", async () => {
    await new CastedFactory().createOne({ published: false, meta: { b: 2 } });

    const raw = await app
      .make<DatabaseManager>(DATABASE_TOKEN)
      .driver()
      .kysely.selectFrom("casted")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(raw.published).toBe(0);
    expect(raw.meta).toBe('{"b":2}');
  });

  it("leaves an uncast column alone", async () => {
    const row = await new CastedFactory().createOne({ note: "plain" });
    expect(row.note).toBe("plain");
  });

  it("still sets guarded columns (a factory bypasses fillable/guarded)", async () => {
    // `forceFill` rather than `fill` — a factory must be able to set an
    // `id` (or any guarded column) on a totally-guarded model.
    class Guarded extends Model<CastedAttributes>()({
      table: "casted",
      primaryKey: "id",
      timestamps: false,
      keyType: "uuid",
      guarded: ["*"],
      casts: { published: Cast.boolean(), meta: Cast.json<Record<string, unknown>>() },
    }) {}

    class GuardedFactory extends Factory<typeof Guarded> {
      protected model = Guarded;
      protected definition(): Record<string, any> {
        return { published: true, meta: null, note: null };
      }
    }

    const row = await new GuardedFactory().createOne();
    expect(row.published).toBe(true);
  });
});
