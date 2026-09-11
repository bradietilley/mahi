import { Application } from "@mahi/core";
import { CACHE_TOKEN, ArrayCacheStore, CacheManager, type CacheStore } from "@mahi/cache";
import { beforeEach, describe, expect, it } from "vitest";
import { Job } from "../src/job.js";
import { JobRegistry } from "../src/job-registry.js";
import { QueueManager } from "../src/queue-manager.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { FakeQueueDriver } from "../src/drivers/fake-queue-driver.js";
import { JOB_REGISTRY_TOKEN } from "../src/tokens.js";
import { uniqueLockKey } from "../src/unique-jobs.js";

/** Records handled runs; blocks until released via a gate when one is set. */
const runs: string[] = [];

class UntilFinishedJob extends Job {
  static unique = "untilFinished" as const;
  static gate: Promise<void> | undefined;
  constructor(public readonly id: string) {
    super();
  }
  uniqueId(): string {
    return this.id;
  }
  async handle(): Promise<void> {
    runs.push(this.id);

    if (UntilFinishedJob.gate) {
      await UntilFinishedJob.gate;
    }
  }
}

class UntilProcessingJob extends Job {
  static unique = "untilProcessing" as const;
  constructor(public readonly id: string) {
    super();
  }
  uniqueId(): string {
    return this.id;
  }
  handle(): void {
    runs.push(`processing:${this.id}`);
  }
}

class PlainJob extends Job {
  constructor(public readonly id: string) {
    super();
  }
  handle(): void {
    runs.push(`plain:${this.id}`);
  }
}

class CustomUniqueForJob extends Job {
  static unique = "untilFinished" as const;
  handle(): void {}
  uniqueFor(): number {
    return 42;
  }
}

function buildApp(store: CacheStore = new ArrayCacheStore({ sweepIntervalSeconds: 0 })): {
  app: Application;
  manager: QueueManager;
  registry: JobRegistry;
  store: CacheStore;
} {
  const app = new Application();

  const registry = new JobRegistry();
  registry.register("until-finished", UntilFinishedJob);
  registry.register("until-processing", UntilProcessingJob);
  registry.register("plain", PlainJob);
  registry.register("custom-unique-for", CustomUniqueForJob);
  app.instance(JOB_REGISTRY_TOKEN, registry);

  const cache = new CacheManager(app, { default: "array", stores: {} });
  cache.extend("array", () => store);
  app.instance(CACHE_TOKEN, cache);

  const manager = new QueueManager(app, { default: "sync", connections: { sync: {} } });
  manager.extend("sync", () => new SyncQueueDriver(app, registry));

  return { app, manager, registry, store };
}

beforeEach(() => {
  runs.length = 0;
  UntilFinishedJob.gate = undefined;
});

describe("uniqueLockKey", () => {
  it("keys on the registry name and uniqueId()", () => {
    expect(uniqueLockKey("until-finished", new UntilFinishedJob("42"))).toBe(
      "mahi:unique:until-finished:42",
    );
  });

  it("uses an empty id for a class-wide unique job", () => {
    expect(uniqueLockKey("custom-unique-for", new CustomUniqueForJob())).toBe(
      "mahi:unique:custom-unique-for:",
    );
  });
});

describe("ShouldBeUnique via FakeQueueDriver (dispatch gate)", () => {
  function fake(): { manager: QueueManager; driver: FakeQueueDriver } {
    const { app, registry, store } = buildApp();
    const manager = new QueueManager(app, { default: "fake", connections: { fake: {} } });
    const driver = new FakeQueueDriver(registry);
    manager.extend("fake", () => driver);
    void store;

    return { manager, driver };
  }

  it("dispatches once for repeated same-uniqueId; second returns false", async () => {
    const { manager, driver } = fake();

    const first = await manager.dispatch(new UntilFinishedJob("A"));
    const second = await manager.dispatch(new UntilFinishedJob("A"));

    expect(first).toBe(true);
    expect(second).toBe(false);
    driver.assertPushedTimes(UntilFinishedJob, 1);
  });

  it("dispatches both when uniqueId differs", async () => {
    const { manager, driver } = fake();

    await manager.dispatch(new UntilFinishedJob("A"));
    await manager.dispatch(new UntilFinishedJob("B"));

    driver.assertPushedTimes(UntilFinishedJob, 2);
  });

  it("never gates a non-unique job", async () => {
    const { manager, driver } = fake();

    await manager.dispatch(new PlainJob("A"));
    await manager.dispatch(new PlainJob("A"));

    driver.assertPushedTimes(PlainJob, 2);
  });
});

describe("ShouldBeUnique lock lifecycle (sync driver)", () => {
  it("releases the untilFinished lock after the job finishes", async () => {
    const { manager, store } = buildApp();

    await manager.dispatch(new UntilFinishedJob("A"));
    expect(runs).toEqual(["A"]);

    // Lock is gone → a second dispatch runs again.
    await manager.dispatch(new UntilFinishedJob("A"));
    expect(runs).toEqual(["A", "A"]);

    expect(
      await store.get(`${uniqueLockKey("until-finished", new UntilFinishedJob("A"))}_lock`),
    ).toBeUndefined();
  });

  it("holds the untilFinished lock while handle() runs (duplicate dropped)", async () => {
    const { manager } = buildApp();

    let release!: () => void;
    UntilFinishedJob.gate = new Promise<void>((r) => {
      release = r;
    });

    const first = manager.dispatch(new UntilFinishedJob("A"));
    // Give the first dispatch a tick to acquire the lock and start handle().
    await Promise.resolve();
    await Promise.resolve();

    const second = await manager.dispatch(new UntilFinishedJob("A"));
    expect(second).toBe(false); // dropped while the first is still running

    release();
    expect(await first).toBe(true);
    expect(runs).toEqual(["A"]);
  });

  it("releases the untilFinished lock when the job throws (terminal in sync)", async () => {
    const { manager } = buildApp();

    class BoomJob extends Job {
      static unique = "untilFinished" as const;
      handle(): void {
        throw new Error("boom");
      }
    }
    (manager as unknown as { app: Application }).app
      .make<JobRegistry>(JOB_REGISTRY_TOKEN)
      .register("boom", BoomJob);

    await expect(manager.dispatch(new BoomJob())).rejects.toThrow("boom");
    // Lock freed → a second dispatch attempts the job again (throws again).
    await expect(manager.dispatch(new BoomJob())).rejects.toThrow("boom");
  });

  it("releases the untilProcessing lock before handle() runs", async () => {
    // The store's `add` for this key should be tried twice successfully:
    // once at dispatch, and once at re-dispatch inside handle(), because
    // the lock was released the instant processing began.
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { manager } = buildApp(store);

    let reDispatched: boolean | undefined;
    class ReentrantJob extends Job {
      static unique = "untilProcessing" as const;
      async handle(): Promise<void> {
        if (reDispatched !== undefined) {
          return;
        } // guard recursion

        // While this runs, a fresh instance can already be queued because
        // the untilProcessing lock was released before handle() started.
        const store2 = store;
        const lock = store2.lock({
          key: uniqueLockKey("reentrant", new ReentrantJob()),
          automaticReleaseAfterSeconds: 3600,
          maximumWaitForSeconds: 0,
        });
        reDispatched = await lock
          .acquire()
          .then(() => true)
          .catch(() => false);
      }
    }
    (manager as unknown as { app: Application }).app
      .make<JobRegistry>(JOB_REGISTRY_TOKEN)
      .register("reentrant", ReentrantJob);

    await manager.dispatch(new ReentrantJob());
    expect(reDispatched).toBe(true);
  });
});

describe("uniqueFor", () => {
  it("passes the job's uniqueFor() as the lock TTL", async () => {
    const captured: number[] = [];
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const originalAdd = store.add.bind(store);
    store.add = async (key, value, ttl) => {
      if (key.startsWith("mahi:unique:")) {
        captured.push(ttl ?? -1);
      }

      return originalAdd(key, value, ttl);
    };

    const { manager } = buildApp(store);
    await manager.dispatch(new CustomUniqueForJob());

    expect(captured).toContain(42);
  });

  it("uses the connection's uniqueFor default when the job defines none", async () => {
    const captured: number[] = [];
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const originalAdd = store.add.bind(store);
    store.add = async (key, value, ttl) => {
      if (key.startsWith("mahi:unique:")) {
        captured.push(ttl ?? -1);
      }

      return originalAdd(key, value, ttl);
    };

    const app = new Application();
    const registry = new JobRegistry();
    registry.register("until-finished", UntilFinishedJob);
    app.instance(JOB_REGISTRY_TOKEN, registry);
    const cache = new CacheManager(app, { default: "array", stores: {} });
    cache.extend("array", () => store);
    app.instance(CACHE_TOKEN, cache);
    const manager = new QueueManager(app, {
      default: "sync",
      connections: { sync: { uniqueFor: 123 } },
    });
    manager.extend("sync", () => new SyncQueueDriver(app, registry));

    await manager.dispatch(new UntilFinishedJob("A"));
    expect(captured).toContain(123);
  });
});

describe("uniqueness without a cache store", () => {
  it("fails open (dispatches) when no cache is bound", async () => {
    const app = new Application();
    const registry = new JobRegistry();
    registry.register("until-finished", UntilFinishedJob);
    app.instance(JOB_REGISTRY_TOKEN, registry);
    const manager = new QueueManager(app, { default: "sync", connections: { sync: {} } });
    manager.extend("sync", () => new SyncQueueDriver(app, registry));

    const first = await manager.dispatch(new UntilFinishedJob("A"));
    const second = await manager.dispatch(new UntilFinishedJob("A"));

    // No lock possible → both proceed (a warning is logged).
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(runs).toEqual(["A", "A"]);
  });
});
