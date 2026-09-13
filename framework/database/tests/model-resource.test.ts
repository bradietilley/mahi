import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { Cast } from "../src/casts.js";

interface GadgetAttributes {
  id: string;
  name: string;
  active: boolean;
}

/** The cast-aware instance shape (DB `active: number` -> model `boolean`). */
type GadgetInstance = { id: string; name: string; active: boolean };

/** A model with no default resource, the base `toJsonResource()` behavior. */
class Gadget extends Model<GadgetAttributes>()({
  table: "gadgets",
  primaryKey: "id",
  timestamps: false,
  casts: { active: Cast.boolean() },
}) {}

/** Minimal resource stand-in, reads a cast column off the wrapped model. */
class GadgetResource {
  constructor(private model: GadgetInstance) {}
  toJson() {
    return { id: this.model.id, name: this.model.name, active: this.model.active };
  }
}

/** A model that declares a default resource, constructed with `this.self`. */
class Widget extends Gadget {
  static override table = "widgets";

  override toJsonResource(): GadgetResource {
    // `this.self` is the casting proxy, reading `this.model.active` in the
    // resource must yield the cast boolean, not the raw DB number.
    return new GadgetResource(this.self as unknown as GadgetInstance);
  }
}

describe("Model.toJsonResource()", () => {
  let app: Application;

  beforeEach(async () => {
    app = new Application();
    const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const { kysely } = manager.driver();

    for (const table of ["gadgets", "widgets"]) {
      await kysely.schema
        .createTable(table)
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("active", "integer", (col) => col.notNull())
        .execute();
    }

    await Gadget.create({ id: "g1", name: "Gizmo", active: 1 });
    await Widget.create({ id: "w1", name: "Sprocket", active: 1 });
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("returns undefined by default (no default resource declared)", async () => {
    const gadget = await Gadget.findOrFail("g1");
    expect(gadget.toJsonResource()).toBeUndefined();
  });

  it("returns the declared resource for a model that overrides it", async () => {
    const widget = await Widget.findOrFail("w1");
    const resource = widget.toJsonResource();
    expect(resource).toBeInstanceOf(GadgetResource);
  });

  it("constructs the resource with the casting proxy, so cast columns resolve", async () => {
    const widget = await Widget.findOrFail("w1");
    // `active` is stored as 1 but cast to boolean; the resource reads it via
    // `this.self`, so it must see `true`, not `1`.
    expect(widget.toJsonResource().toJson()).toEqual({ id: "w1", name: "Sprocket", active: true });
  });
});
