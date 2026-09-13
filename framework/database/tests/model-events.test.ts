import { afterEach, describe, expect, it } from "vitest";
import { app, Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  AbstractEvent,
  AbstractEvent as Event,
  EventDispatcher,
  EventsServiceProvider,
  EVENTS_TOKEN,
  type Listener,
} from "@mahiframework/events";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model, BaseModel } from "../src/model.js";
import { ModelCreated, ModelObserver, type DispatchesEventsMap } from "../src/model-events.js";

interface WidgetAttributes {
  id: string;
  name: string;
}
type WidgetTable = WidgetAttributes;

class WidgetCreated extends AbstractEvent {
  constructor(public readonly widget: WidgetTable) {
    super();
  }
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {
  static override dispatchesEvents: DispatchesEventsMap = {
    created: WidgetCreated,
  };
}

class PlainWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

interface GadgetAttributes {
  id: string;
  name: string;
}
type GadgetTable = GadgetAttributes;

class Gadget extends Model<GadgetAttributes>()({
  table: "gadgets",
  primaryKey: "id",
  timestamps: false,
}) {}

// A dedicated class for the "instance payload is mutable" test, so its
// mutating `saving` listener doesn't leak into other PlainWidget tests
// (the listener registry is module-level, keyed by class, with no
// unregister API).
class MutWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

async function setupApp(withEvents = false): Promise<Application> {
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);

  if (withEvents) {
    app.register(EventsServiceProvider);
  }

  await app.bootstrap();
  setCurrentApp(app);

  await manager
    .driver()
    .kysely.schema.createTable("widgets")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();

  await manager
    .driver()
    .kysely.schema.createTable("gadgets")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();

  return app;
}

describe("Model events", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  describe("Model.on()", () => {
    it("fires creating/created/saving/saved in order with the right payload, without EventsServiceProvider bootstrapped", async () => {
      await setupApp(false);
      const fired: string[] = [];

      PlainWidget.on("saving", () => {
        fired.push("saving");
      });
      PlainWidget.on("creating", () => {
        fired.push("creating");
      });
      PlainWidget.on("created", (row) => {
        fired.push(`created:${(row as WidgetTable).id}`);
      });
      PlainWidget.on("saved", (row) => {
        fired.push(`saved:${(row as WidgetTable).id}`);
      });

      await PlainWidget.create({ id: "1", name: "Sprocket" });

      expect(fired).toEqual(["saving", "creating", "created:1", "saved:1"]);
    });

    it("passes the model INSTANCE as the payload for create()/save(), mutable in creating/saving", async () => {
      await setupApp(false);
      let sawInstance = false;

      MutWidget.on("saving", (payload) => {
        sawInstance = payload instanceof BaseModel;
        // mutating in place should change what is written
        (payload as any).name = `${(payload as any).name}!`;
      });

      const created = await MutWidget.create({ id: "1", name: "Sprocket" });
      expect(sawInstance).toBe(true);
      expect((created as any).name).toBe("Sprocket!");

      const found = await MutWidget.find("1");
      expect((found as any).name).toBe("Sprocket!");
    });

    it("fires updating/updated/saving/saved with the primary key merged into the payload", async () => {
      await setupApp(false);
      await PlainWidget.create({ id: "1", name: "Sprocket" });

      const payloads: Record<string, any>[] = [];
      PlainWidget.on("updating", (row) => {
        payloads.push({ event: "updating", ...row });
      });
      PlainWidget.on("updated", (row) => {
        payloads.push({ event: "updated", ...row });
      });

      await PlainWidget.update("1", { name: "Cog" });

      expect(payloads).toEqual([
        { event: "updating", name: "Cog", id: "1" },
        { event: "updated", name: "Cog", id: "1" },
      ]);
    });

    it("fires deleting/deleted with the loaded model INSTANCE as payload", async () => {
      await setupApp(false);
      await PlainWidget.create({ id: "1", name: "Sprocket" });

      const fired: string[] = [];
      const payloads: unknown[] = [];
      PlainWidget.on("deleting", (row) => {
        fired.push(`deleting:${(row as any).id}`);
        payloads.push(row);
      });
      PlainWidget.on("deleted", (row) => {
        fired.push(`deleted:${(row as any).id}`);
      });

      await PlainWidget.delete("1");

      expect(fired).toEqual(["deleting:1", "deleted:1"]);
      // Laravel-faithful: the payload is the real, fully-attributed
      // instance (so a listener can read any column), not a bare
      // { id } object. See Model.delete()'s docstring.
      expect(payloads[0]).toBeInstanceOf(BaseModel);
      expect((payloads[0] as any).name).toBe("Sprocket");
    });

    it("falls back to { [primaryKeyColumn]: id } when no row matches the id", async () => {
      await setupApp(false);

      const payloads: unknown[] = [];
      PlainWidget.on("deleting", (row) => {
        payloads.push(row);
      });

      await PlainWidget.delete("does-not-exist");

      expect(payloads[0]).not.toBeInstanceOf(BaseModel);
      expect(payloads[0]).toEqual({ id: "does-not-exist" });
    });
  });

  describe("ModelObserver", () => {
    it("observe() registers an observer whose overridden methods fire at the matching lifecycle points", async () => {
      await setupApp(false);
      const fired: string[] = [];

      class RecordingObserver extends ModelObserver<WidgetTable> {
        override creating(): void {
          fired.push("creating");
        }
        override created(row: WidgetTable): void {
          fired.push(`created:${row.id}`);
        }
      }

      PlainWidget.observe(RecordingObserver);

      await PlainWidget.create({ id: "1", name: "Sprocket" });

      expect(fired).toEqual(["creating", "created:1"]);
    });

    it("only overridden methods fire, unset methods are silently skipped", async () => {
      await setupApp(false);
      let calls = 0;

      class OnlyDeletingObserver extends ModelObserver<WidgetTable> {
        override deleting(): void {
          calls++;
        }
      }

      PlainWidget.observe(OnlyDeletingObserver);

      await PlainWidget.create({ id: "1", name: "Sprocket" });
      await PlainWidget.update("1", { name: "Cog" });
      expect(calls).toBe(0);

      await PlainWidget.delete("1");
      expect(calls).toBe(1);
    });
  });

  describe("Model.withoutEvents()", () => {
    it("suppresses on() listeners and observers for calls made inside the callback", async () => {
      await setupApp(false);
      const fired: string[] = [];
      PlainWidget.on("created", (row) => {
        fired.push((row as WidgetTable).id);
      });

      await PlainWidget.withoutEvents(async () => {
        await PlainWidget.create({ id: "1", name: "Sprocket" });
      });

      expect(fired).toEqual([]);

      // events resume normally after withoutEvents() returns
      await PlainWidget.create({ id: "2", name: "Cog" });
      expect(fired).toEqual(["2"]);
    });

    it("suppresses events fired via nested async calls inside the callback", async () => {
      await setupApp(false);
      const fired: string[] = [];
      PlainWidget.on("created", (row) => {
        fired.push((row as WidgetTable).id);
      });

      async function nestedCreate() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await PlainWidget.create({ id: "1", name: "Sprocket" });
      }

      await PlainWidget.withoutEvents(async () => {
        await nestedCreate();
      });

      expect(fired).toEqual([]);
    });

    it("is scoped to this model's table only, a different model's events are unaffected", async () => {
      await setupApp(false);
      const widgetFired: string[] = [];
      const gadgetFired: string[] = [];
      PlainWidget.on("created", (row) => {
        widgetFired.push((row as WidgetTable).id);
      });
      Gadget.on("created", (row) => {
        gadgetFired.push((row as GadgetTable).id);
      });

      await PlainWidget.withoutEvents(async () => {
        await PlainWidget.create({ id: "1", name: "Sprocket" });
        await Gadget.create({ id: "1", name: "Wrench" });
      });

      expect(widgetFired).toEqual([]);
      expect(gadgetFired).toEqual(["1"]);
    });

    it("called on the base Model class widens the suppression to every model", async () => {
      await setupApp(false);
      const widgetFired: string[] = [];
      const gadgetFired: string[] = [];
      PlainWidget.on("created", (row) => {
        widgetFired.push((row as WidgetTable).id);
      });
      Gadget.on("created", (row) => {
        gadgetFired.push((row as GadgetTable).id);
      });

      await BaseModel.withoutEvents(async () => {
        await PlainWidget.create({ id: "1", name: "Sprocket" });
        await Gadget.create({ id: "1", name: "Wrench" });
      });

      expect(widgetFired).toEqual([]);
      expect(gadgetFired).toEqual([]);
    });

    it("also suppresses the dispatchesEvents-mapped Event through EventDispatcher, scoped to this model", async () => {
      await setupApp(true);
      const widgetHandled: unknown[] = [];

      class RecordWidgetCreated implements Listener<WidgetCreated> {
        handle(event: WidgetCreated) {
          widgetHandled.push(event);
        }
      }
      app().make<EventDispatcher>(EVENTS_TOKEN).listen(WidgetCreated, RecordWidgetCreated);

      await Widget.withoutEvents(async () => {
        await Widget.create({ id: "1", name: "Sprocket" });
      });

      expect(widgetHandled).toEqual([]);

      // resumes normally afterwards
      await Widget.create({ id: "2", name: "Cog" });
      expect(widgetHandled).toHaveLength(1);
    });

    it("nests correctly with a broader Event.suppress() call. Both stay in effect", async () => {
      await setupApp(false);
      const widgetFired: string[] = [];
      const gadgetFired: string[] = [];
      PlainWidget.on("created", (row) => {
        widgetFired.push((row as WidgetTable).id);
      });
      Gadget.on("created", (row) => {
        gadgetFired.push((row as GadgetTable).id);
      });

      await Event.suppress(async () => {
        await PlainWidget.withoutEvents(async () => {
          // both "model.gadgets.*" (outer) and "model.widgets.*" (inner) active here
          await PlainWidget.create({ id: "1", name: "Sprocket" });
          await Gadget.create({ id: "1", name: "Wrench" });
        });
      }, ["model.gadgets.*"]);

      expect(widgetFired).toEqual([]);
      expect(gadgetFired).toEqual([]);
    });

    it("does not suppress timestamp stamping (a separate concern)", async () => {
      class TimestampedWidget extends Model<{
        id: string;
        name: string;
        created_at?: string | null;
        updated_at?: string | null;
      }>()({
        table: "ts_widgets",
        primaryKey: "id",
        timestamps: true,
      }) {}

      const currentApp = await setupApp(false);
      await currentApp
        .make<DatabaseManager>(DATABASE_TOKEN)
        .driver()
        .kysely.schema.createTable("ts_widgets")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("created_at", "text")
        .addColumn("updated_at", "text")
        .execute();

      const created = await TimestampedWidget.withoutEvents(() =>
        TimestampedWidget.create({ id: "1", name: "Sprocket" }),
      );

      expect(created.created_at).toBeTruthy();
    });
  });

  describe("dispatchesEvents + generic lifecycle events via EventDispatcher", () => {
    it("dispatches the model's dispatchesEvents-mapped Event class through EventDispatcher", async () => {
      await setupApp(true);
      const handled: WidgetTable[] = [];

      class RecordWidgetCreated implements Listener<WidgetCreated> {
        handle(event: WidgetCreated) {
          handled.push(event.widget);
        }
      }

      app().make<EventDispatcher>(EVENTS_TOKEN).listen(WidgetCreated, RecordWidgetCreated);

      const created = await Widget.create({ id: "1", name: "Sprocket" });

      expect(handled).toEqual([created]);
    });

    it("dispatches the generic ModelCreated lifecycle event through EventDispatcher for every model, even without dispatchesEvents", async () => {
      await setupApp(true);
      const handled: unknown[] = [];

      class RecordModelCreated implements Listener<ModelCreated> {
        handle(event: ModelCreated) {
          handled.push({ model: event.model, payload: event.payload });
        }
      }

      app().make<EventDispatcher>(EVENTS_TOKEN).listen(ModelCreated, RecordModelCreated);

      const created = await PlainWidget.create({ id: "1", name: "Sprocket" });

      // The generic ModelCreated payload is now the model INSTANCE.
      expect(handled).toEqual([{ model: PlainWidget, payload: created }]);
      expect((handled[0] as any).payload).toBeInstanceOf(PlainWidget);
    });

    it("gracefully no-ops dispatchesEvents/generic dispatch when EventsServiceProvider was never bootstrapped", async () => {
      await setupApp(false);

      await expect(Widget.create({ id: "1", name: "Sprocket" })).resolves.toMatchObject({
        name: "Sprocket",
      });
    });

    it("Event.suppress() also suppresses dispatchesEvents/generic EventDispatcher dispatch", async () => {
      await setupApp(true);
      const handled: unknown[] = [];

      class RecordWidgetCreated implements Listener<WidgetCreated> {
        handle(event: WidgetCreated) {
          handled.push(event);
        }
      }

      app().make<EventDispatcher>(EVENTS_TOKEN).listen(WidgetCreated, RecordWidgetCreated);

      await Widget.withoutEvents(async () => {
        await Widget.create({ id: "1", name: "Sprocket" });
      });

      expect(handled).toEqual([]);
    });
  });
});
