import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { DATABASE_TOKEN, DatabaseManager, SqliteDriver, transaction } from "@mahi/database";
import { QueueManager } from "../src/queue-manager.js";
import { JobRegistry } from "../src/job-registry.js";
import { Job } from "../src/job.js";
import { FakeQueueDriver } from "../src/drivers/fake-queue-driver.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { JOB_REGISTRY_TOKEN } from "../src/tokens.js";

class ChargeOrderJob extends Job {
  static ran: string[] = [];
  constructor(public readonly orderId: string) {
    super();
  }
  handle(): void {
    ChargeOrderJob.ran.push(this.orderId);
  }
}

/** A job whose class opts into after-commit dispatch, Laravel's `$afterCommit`. */
class DeferredByDefaultJob extends Job {
  afterCommit = true;
  handle(): void {}
}

/**
 * An app with a real SQLite connection (so `transaction()` has something
 * to open) and a queue manager whose `fake` connection records pushes.
 */
function buildApp(connections: Record<string, any> = { fake: {} }) {
  const driver = new SqliteDriver({ filename: ":memory:" });
  const app = new Application();

  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => driver);
  app.instance(DATABASE_TOKEN, database);
  setCurrentApp(app);

  const registry = new JobRegistry();
  registry.register("charge-order", ChargeOrderJob);
  registry.register("deferred", DeferredByDefaultJob);
  app.instance(JOB_REGISTRY_TOKEN, registry);

  const queue = new QueueManager(app, { default: "fake", connections });
  const fake = new FakeQueueDriver(registry);
  queue.extend("fake", () => fake);
  queue.extend("sync", () => new SyncQueueDriver(app, registry));

  return { app, queue, fake, db: driver };
}

describe("dispatching inside a transaction", () => {
  let context: ReturnType<typeof buildApp>;

  beforeEach(() => {
    ChargeOrderJob.ran = [];
    context = buildApp();
  });

  afterEach(async () => {
    clearCurrentApp();
    await context.db.disconnect();
  });

  it("dispatches immediately by default, even inside a transaction", async () => {
    const { queue, fake, db } = context;

    await transaction(db.kysely, async () => {
      await queue.dispatch(new ChargeOrderJob("o1"));
      // Already pushed — this is the pre-existing (racy) behaviour, kept
      // as the default so nothing silently changes meaning.
      expect(fake.pushed(ChargeOrderJob)).toHaveLength(1);
    });

    fake.assertPushedTimes(ChargeOrderJob, 1);
  });

  it("{ afterCommit: true } pushes nothing until the transaction commits", async () => {
    const { queue, fake, db } = context;

    await transaction(db.kysely, async () => {
      await queue.dispatch(new ChargeOrderJob("o1"), { afterCommit: true });
      fake.assertNothingPushed();
    });

    fake.assertPushedTimes(ChargeOrderJob, 1);
    fake.assertPushedAfterCommit(ChargeOrderJob);
  });

  it("{ afterCommit: true } pushes nothing at all when the transaction rolls back", async () => {
    const { queue, fake, db } = context;

    await expect(
      transaction(db.kysely, async () => {
        await queue.dispatch(new ChargeOrderJob("o1"), { afterCommit: true });
        throw new Error("payment declined");
      }),
    ).rejects.toThrow("payment declined");

    fake.assertNothingPushed();
  });

  it("pushes exactly once — not once per nested transaction level", async () => {
    const { queue, fake, db } = context;

    await transaction(db.kysely, async () => {
      await transaction(db.kysely, async () => {
        await queue.dispatch(new ChargeOrderJob("o1"), { afterCommit: true });
      });
      fake.assertNothingPushed(); // the savepoint release is not a commit
    });

    fake.assertPushedTimes(ChargeOrderJob, 1);
  });

  it("drops a dispatch made inside a savepoint that rolls back", async () => {
    const { queue, fake, db } = context;

    await transaction(db.kysely, async () => {
      await expect(
        transaction(db.kysely, async () => {
          await queue.dispatch(new ChargeOrderJob("inner"), { afterCommit: true });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");

      await queue.dispatch(new ChargeOrderJob("outer"), { afterCommit: true });
    });

    expect(fake.pushed(ChargeOrderJob).map((j) => j.state.orderId)).toEqual(["outer"]);
  });

  it("outside a transaction, { afterCommit: true } pushes immediately", async () => {
    const { queue, fake } = context;
    await queue.dispatch(new ChargeOrderJob("o1"), { afterCommit: true });
    fake.assertPushedTimes(ChargeOrderJob, 1);
  });

  describe("configuration precedence", () => {
    it("a connection configured afterCommit defers every dispatch on it", async () => {
      const local = buildApp({ fake: { afterCommit: true } });
      try {
        await transaction(local.db.kysely, async () => {
          await local.queue.dispatch(new ChargeOrderJob("o1"));
          local.fake.assertNothingPushed();
        });
        local.fake.assertPushedTimes(ChargeOrderJob, 1);
      } finally {
        await local.db.disconnect();
      }
    });

    it("a job class's own afterCommit defers it on a connection that doesn't", async () => {
      const { queue, fake, db } = context;

      await transaction(db.kysely, async () => {
        await queue.dispatch(new DeferredByDefaultJob());
        fake.assertNothingPushed();
      });

      fake.assertPushedTimes(DeferredByDefaultJob, 1);
    });

    it("an explicit { afterCommit: false } overrides the connection's default", async () => {
      const local = buildApp({ fake: { afterCommit: true } });
      try {
        await transaction(local.db.kysely, async () => {
          await local.queue.dispatch(new ChargeOrderJob("o1"), { afterCommit: false });
          local.fake.assertPushedTimes(ChargeOrderJob, 1);
        });
      } finally {
        await local.db.disconnect();
      }
    });
  });

  describe("the sync driver honours it too", () => {
    it("does not run a deferred job when the transaction rolls back", async () => {
      const local = buildApp({ sync: {} });
      try {
        await expect(
          transaction(local.db.kysely, async () => {
            await local.queue.dispatch(new ChargeOrderJob("o1"), {
              connection: "sync",
              afterCommit: true,
            });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");

        expect(ChargeOrderJob.ran).toEqual([]);
      } finally {
        await local.db.disconnect();
      }
    });

    it("runs a deferred job once the transaction commits", async () => {
      const local = buildApp({ sync: {} });
      try {
        await transaction(local.db.kysely, async () => {
          await local.queue.dispatch(new ChargeOrderJob("o1"), {
            connection: "sync",
            afterCommit: true,
          });
          expect(ChargeOrderJob.ran).toEqual([]);
        });

        expect(ChargeOrderJob.ran).toEqual(["o1"]);
      } finally {
        await local.db.disconnect();
      }
    });
  });

  describe("chains", () => {
    it("a deferred chain pushes its head once, after commit, with the rest attached", async () => {
      const { queue, fake, db } = context;

      await transaction(db.kysely, async () => {
        await queue.chain([new ChargeOrderJob("a"), new ChargeOrderJob("b")], {
          afterCommit: true,
        });
        fake.assertNothingPushed();
      });

      const [head, ...others] = fake.pushed();
      expect(others).toHaveLength(0);
      expect(head?.state.orderId).toBe("a");
      expect(head?.chain).toHaveLength(1);
    });
  });
});
