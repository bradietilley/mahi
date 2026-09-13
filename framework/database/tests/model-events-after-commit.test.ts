import { afterEach, describe, expect, it } from "vitest";
import {
  Application,
  clearCurrentApp,
  setCurrentApp,
  setAfterCommitResolver,
  clearAfterCommitResolver,
} from "@mahiframework/core";
import {
  AbstractEvent,
  EventDispatcher,
  EventsServiceProvider,
  EVENTS_TOKEN,
} from "@mahiframework/events";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN } from "../src/database-service-provider.js";
import { Model } from "../src/model.js";
import { transaction } from "../src/transaction.js";
import { afterCommit, inTransaction } from "../src/transaction-context.js";

interface WidgetAttributes {
  id: string;
  name: string;
}

/** Opts into deferring its lifecycle events until the transaction commits. */
class DeferredWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {
  static override dispatchesEventsAfterCommit = true;
}

/** Fires its lifecycle events inline (the default). */
class InlineWidget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {}

class WidgetCreatedEvent extends AbstractEvent {
  static shouldDispatchAfterCommit = true;
  constructor(public readonly id: string) {
    super();
  }
}

async function setupApp(): Promise<{ app: Application; db: SqliteDriver }> {
  const app = new Application();
  const driver = new SqliteDriver({ filename: ":memory:" });
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => driver);
  app.instance(DATABASE_TOKEN, manager);

  // Wire the after-commit seam the way DatabaseServiceProvider does, without
  // standing up the whole provider (which rebuilds the manager from config).
  setAfterCommitResolver({
    run: (cb) => afterCommit(cb),
    active: () => inTransaction(),
  });

  app.register(EventsServiceProvider);
  await app.bootstrap();
  setCurrentApp(app);

  await driver.kysely.schema
    .createTable("widgets")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();

  return { app, db: driver };
}

describe("model events: after commit", () => {
  afterEach(() => {
    clearCurrentApp();
    clearAfterCommitResolver();
  });

  it("defers a deferring model's `created` event until the outer commit", async () => {
    const { db } = await setupApp();
    const order: string[] = [];
    DeferredWidget.on("created", (w) => {
      order.push(`created:${(w as WidgetAttributes).id}`);
    });

    await transaction(db.kysely, async () => {
      await DeferredWidget.create({ id: "1", name: "A" });
      order.push("still-inside");
    });
    order.push("returned");

    // The `created` observer ran only after the commit.
    expect(order).toEqual(["still-inside", "created:1", "returned"]);
  });

  it("drops a deferring model's events when the transaction rolls back", async () => {
    const { db } = await setupApp();
    const fired: string[] = [];
    DeferredWidget.on("created", () => {
      fired.push("created");
    });

    await expect(
      transaction(db.kysely, async () => {
        await DeferredWidget.create({ id: "1", name: "A" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(fired).toEqual([]);
  });

  it("still fires `creating` (a before-hook) inline, not deferred", async () => {
    const { db } = await setupApp();
    const order: string[] = [];
    DeferredWidget.on("creating", () => {
      order.push("creating");
    });
    DeferredWidget.on("created", () => {
      order.push("created");
    });

    await transaction(db.kysely, async () => {
      await DeferredWidget.create({ id: "1", name: "A" });
      order.push("inside");
    });

    // `creating` ran inline (before the write); `created` waited for commit.
    expect(order).toEqual(["creating", "inside", "created"]);
  });

  it("fires an inline model's events immediately inside the transaction", async () => {
    const { db } = await setupApp();
    const order: string[] = [];
    InlineWidget.on("created", () => {
      order.push("created");
    });

    await transaction(db.kysely, async () => {
      await InlineWidget.create({ id: "1", name: "A" });
      order.push("inside");
    });

    expect(order).toEqual(["created", "inside"]);
  });

  it("an event marked shouldDispatchAfterCommit, dispatched in a transaction, waits for commit", async () => {
    const { app, db } = await setupApp();
    const dispatcher = app.make<EventDispatcher>(EVENTS_TOKEN);
    const seen: string[] = [];
    dispatcher.listen(
      WidgetCreatedEvent,
      class {
        handle(e: WidgetCreatedEvent) {
          seen.push(e.id);
        }
      } as never,
    );

    await transaction(db.kysely, async () => {
      await dispatcher.dispatch(new WidgetCreatedEvent("1"));
      seen.push("inside");
    });

    expect(seen).toEqual(["inside", "1"]);
  });

  it("never delivers such an event when the transaction rolls back", async () => {
    const { app, db } = await setupApp();
    const dispatcher = app.make<EventDispatcher>(EVENTS_TOKEN);
    const seen: string[] = [];
    dispatcher.listen(
      WidgetCreatedEvent,
      class {
        handle(e: WidgetCreatedEvent) {
          seen.push(e.id);
        }
      } as never,
    );

    await expect(
      transaction(db.kysely, async () => {
        await dispatcher.dispatch(new WidgetCreatedEvent("1"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(seen).toEqual([]);
  });
});
