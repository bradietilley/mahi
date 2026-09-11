import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider } from "@mahi/core";
import { DatabaseServiceProvider, Model } from "@mahi/database";
import {
  AbstractEvent,
  EventsServiceProvider,
  EVENTS_TOKEN,
  type EventDispatcher,
} from "@mahi/events";
import {
  Job,
  QueueServiceProvider,
  QUEUE_TOKEN,
  type QueueManager,
  type JobClass,
} from "@mahi/queue";
import { createTestApplication } from "../src/create-test-application.js";
import {
  assertDatabaseHas,
  assertDatabaseMissing,
  assertDatabaseCount,
  assertSoftDeleted,
  assertNotSoftDeleted,
} from "../src/database-assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = path.join(__dirname, "__fixtures__/migrations");

interface WidgetAttributes {
  id: string;
  name: string;
}

class Widget extends Model<WidgetAttributes>()({
  table: "widgets",
  primaryKey: "id",
  timestamps: false,
}) {}

interface GadgetAttributes {
  id: string;
  name: string;
  archived_at: string | null;
}

/** Soft-deletes into `archived_at`, NOT the conventional `deleted_at`. */
class Gadget extends Model<GadgetAttributes>()({
  table: "gadgets",
  primaryKey: "id",
  timestamps: false,
  softDeletes: { column: "archived_at" },
}) {}

class SideEffectJob extends Job {
  static ran = 0;
  constructor(public readonly id: string) {
    super();
  }
  handle(): void {
    SideEffectJob.ran++;
  }
}

class WidgetMade extends AbstractEvent {
  constructor(public readonly widgetId: string) {
    super();
  }
}

/** Fixture app wiring database + queue + events (no HTTP — avoids the cache dep). */
class WidgetsProvider extends ServiceProvider {
  migrations(): string {
    return FIXTURE_MIGRATIONS_DIR;
  }

  jobs(): Record<string, JobClass> {
    return { "widgets:side-effect": SideEffectJob };
  }
}

async function bootstrapFixtureApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    migrationsPath: "database/migrations",
    connections: { sqlite: { filename: process.env.DB_FILENAME } },
  });
  app.config.set("queue", { default: "sync", connections: { sync: {}, database: {}, fake: {} } });

  app.register(DatabaseServiceProvider);
  app.register(EventsServiceProvider);
  app.register(QueueServiceProvider);
  app.register(WidgetsProvider);

  await app.bootstrap();

  return app;
}

async function makeWidget(app: Application, name: string): Promise<Widget> {
  return Widget.create({ id: randomUUID(), name }) as Promise<Widget>;
}

describe("assertDatabaseHas/Missing/Count", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
  });

  it("asserts presence and absence of rows by criteria", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      const widget = await makeWidget(testApp.app, "Sprocket");

      await expect(
        assertDatabaseHas(testApp.app, "widgets", { id: widget.id, name: "Sprocket" }),
      ).resolves.toBeUndefined();
      await expect(
        assertDatabaseMissing(testApp.app, "widgets", { name: "Nonexistent" }),
      ).resolves.toBeUndefined();
      await assertDatabaseCount(testApp.app, "widgets", 1);
    } finally {
      await testApp.cleanup();
    }
  });

  it("assertDatabaseHas throws when no row matches", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      await expect(assertDatabaseHas(testApp.app, "widgets", { name: "Ghost" })).rejects.toThrow(
        /contains a row/,
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("assertDatabaseMissing throws when a row matches", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      await makeWidget(testApp.app, "Real");
      await expect(assertDatabaseMissing(testApp.app, "widgets", { name: "Real" })).rejects.toThrow(
        /does not contain/,
      );
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("resetDatabase()", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
  });

  it("wipes all rows but keeps the schema", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      await makeWidget(testApp.app, "One");
      await assertDatabaseCount(testApp.app, "widgets", 1);

      await testApp.resetDatabase();

      await assertDatabaseCount(testApp.app, "widgets", 0);
      // schema still present — inserting again works
      await makeWidget(testApp.app, "Two");
      await assertDatabaseCount(testApp.app, "widgets", 1);
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeQueue", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
  });

  it("records dispatches without running jobs when fakeQueue is set", async () => {
    SideEffectJob.ran = 0;
    const testApp = await createTestApplication(bootstrapFixtureApp, { fakeQueue: true });
    try {
      const manager = testApp.app.make<QueueManager>(QUEUE_TOKEN);
      await manager.dispatch(new SideEffectJob("w1"));

      expect(SideEffectJob.ran).toBe(0);
      expect(testApp.queue).toBeDefined();
      testApp.queue!.assertPushed("widgets:side-effect");
      testApp.queue!.assertPushed(
        "widgets:side-effect",
        (j) => (j.state as { id: string }).id === "w1",
      );
      testApp.queue!.assertNotPushed("widgets:other");
    } finally {
      await testApp.cleanup();
    }
  });

  it("without fakeQueue the sync driver runs the job for real", async () => {
    SideEffectJob.ran = 0;
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      const manager = testApp.app.make<QueueManager>(QUEUE_TOKEN);
      await manager.dispatch(new SideEffectJob("w1"));

      expect(SideEffectJob.ran).toBe(1);
      expect(testApp.queue).toBeUndefined();
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeEvents", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
  });

  it("records dispatched events and runs no listeners when fakeEvents is set", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp, { fakeEvents: true });
    try {
      const dispatcher = testApp.app.make<EventDispatcher>(EVENTS_TOKEN);
      await dispatcher.dispatch(new WidgetMade("w1"));

      expect(testApp.events).toBeDefined();
      testApp.events!.assertDispatched(WidgetMade);
      testApp.events!.assertDispatched(WidgetMade, (e) => e.widgetId === "w1");
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("assertSoftDeleted / assertNotSoftDeleted", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
  });

  const makeGadget = (name: string) =>
    Gadget.create({ id: randomUUID(), name, archived_at: null }) as Promise<Gadget>;

  it("passes for a soft-deleted row and fails for a live one", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      const gadget = await makeGadget("Widget A");

      await expect(assertNotSoftDeleted(testApp.app, Gadget, { id: gadget.id })).resolves.toBe(
        undefined,
      );
      await expect(assertSoftDeleted(testApp.app, Gadget, { id: gadget.id })).rejects.toThrow(
        /\[archived_at\] is null on all of them/,
      );

      await gadget.deleteInstance();

      await expect(assertSoftDeleted(testApp.app, Gadget, { id: gadget.id })).resolves.toBe(
        undefined,
      );
      await expect(assertNotSoftDeleted(testApp.app, Gadget, { id: gadget.id })).rejects.toThrow(
        /\[archived_at\] is set on all of them/,
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("reads the delete column off the model, not the convention", async () => {
    // The reason to pass a model rather than a table name. This model
    // archives into `archived_at`; an assertion assuming `deleted_at`
    // would query a column that does not exist here.
    expect(Gadget.softDeleteColumn).toBe("archived_at");
    expect(Widget.softDeleteColumn).toBeUndefined();
  });

  it("distinguishes a soft delete from a hard one, which assertDatabaseMissing cannot", async () => {
    // The whole point of the assertion. assertDatabaseMissing() passes for
    // a hard delete, a soft delete, and a row that was never written — so
    // it cannot tell a working soft delete from a destructive bug.
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      const gadget = await makeGadget("Widget B");
      await gadget.forceDelete();

      await expect(assertDatabaseMissing(testApp.app, "gadgets", { id: gadget.id })).resolves.toBe(
        undefined,
      );

      await expect(assertSoftDeleted(testApp.app, Gadget, { id: gadget.id })).rejects.toThrow(
        /a hard delete would also look like this/,
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("refuses a model that does not soft-delete at all", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      await expect(assertSoftDeleted(testApp.app, Widget, { id: "x" })).rejects.toThrow(
        /does not use soft deletes/,
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("accepts a table name, assuming the conventional column", async () => {
    const testApp = await createTestApplication(bootstrapFixtureApp);
    try {
      // `users` uses the conventional name, so the string form works.
      await expect(assertSoftDeleted(testApp.app, "gadgets", { id: "nope" })).rejects.toThrow(
        /Found no row at all/,
      );
    } finally {
      await testApp.cleanup();
    }
  });
});
