import { Application } from "@mahi/core";
import { ArrayCacheStore, CACHE_TOKEN, CacheManager, type CacheStore } from "@mahi/cache";
import { beforeEach, describe, expect, it } from "vitest";
import { Job } from "../src/job.js";
import { JobRegistry } from "../src/job-registry.js";
import { QueueManager } from "../src/queue-manager.js";
import { QueueWorkCommand } from "../src/commands/queue-work.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { JOB_REGISTRY_TOKEN, QUEUE_TOKEN } from "../src/tokens.js";
import { uniqueLockKey } from "../src/unique-jobs.js";
import type { JobState } from "../src/job-serialization.js";
import type { PushOptions, QueueDriver, QueuedJob } from "../src/queue-driver.js";

/**
 * Uniqueness applies to each link of a chain independently, but only the
 * *head* of a chain goes through `QueueManager.dispatch()` — every tail
 * link is pushed by whoever advances the chain. Those paths used to skip
 * `acquireUniqueLock()` entirely, so a `ShouldBeUnique` job enqueued as a
 * tail link could duplicate one already queued.
 */

const runs: string[] = [];

class UniqueStepJob extends Job {
  static unique = "untilFinished" as const;
  constructor(public readonly step: string) {
    super();
  }
  uniqueId(): string {
    return this.step;
  }
  handle(): void {
    runs.push(this.step);
  }
}

class PlainStepJob extends Job {
  constructor(public readonly step: string) {
    super();
  }
  handle(): void {
    runs.push(`plain:${this.step}`);
  }
}

function buildApp(store: CacheStore): { app: Application; registry: JobRegistry } {
  const app = new Application();
  const registry = new JobRegistry();
  registry.register("unique-step", UniqueStepJob);
  registry.register("plain-step", PlainStepJob);
  app.instance(JOB_REGISTRY_TOKEN, registry);

  const cache = new CacheManager(app, { default: "array", stores: {} });
  cache.extend("array", () => store);
  app.instance(CACHE_TOKEN, cache);

  return { app, registry };
}

/** Holds the lock a link would need, as if an identical job were already queued. */
async function holdLockFor(store: CacheStore, registryName: string, job: Job): Promise<void> {
  const lock = store.lock({
    key: uniqueLockKey(registryName, job),
    automaticReleaseAfterSeconds: 3600,
    maximumWaitForSeconds: 0,
  });
  await lock.acquire();
}

/** Plays back pre-seeded jobs and records pushes — the chain-advance probe. */
class RecordingDriver implements QueueDriver {
  pushed: Array<{ jobClass: string; state: JobState; options?: PushOptions }> = [];
  deleted: QueuedJob[] = [];
  private queue: QueuedJob[];

  constructor(jobs: QueuedJob[]) {
    this.queue = jobs;
  }

  async push(jobClass: string, state: JobState, options?: PushOptions): Promise<void> {
    this.pushed.push({ jobClass, state, options });
  }
  async pop(): Promise<QueuedJob | undefined> {
    return this.queue.shift();
  }
  async release(): Promise<void> {}
  async delete(job: QueuedJob): Promise<void> {
    this.deleted.push(job);
  }
  async fail(): Promise<void> {}
}

beforeEach(() => {
  runs.length = 0;
});

describe("chained unique jobs — durable worker advance", () => {
  function workerFor(
    store: CacheStore,
    chain: QueuedJob["chain"],
    headClass = "plain-step",
    headState: JobState = { step: "head" },
  ): { command: QueueWorkCommand; driver: RecordingDriver; app: Application } {
    const { app } = buildApp(store);
    const head: QueuedJob = { id: "1", jobClass: headClass, state: headState, attempts: 0, chain };
    const driver = new RecordingDriver([head]);
    const manager = new QueueManager(app, { default: "rec", connections: { rec: {} } });
    manager.extend("rec", () => driver);
    app.instance(QUEUE_TOKEN, manager);

    return { command: new QueueWorkCommand(app), driver, app };
  }

  it("acquires the next link's uniqueness lock before pushing it", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { command, driver } = workerFor(store, [
      { jobClass: "unique-step", state: { step: "b" } },
    ]);

    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed).toHaveLength(1);
    // The lock is now held, so an identical direct dispatch is dropped.
    const { app } = buildApp(store);
    const manager = new QueueManager(app, { default: "rec", connections: { rec: {} } });
    manager.extend("rec", () => new RecordingDriver([]));
    expect(await manager.dispatch(new UniqueStepJob("b"))).toBe(false);
  });

  it("drops a chained link whose unique lock is already held", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    await holdLockFor(store, "unique-step", new UniqueStepJob("b"));

    const { command, driver } = workerFor(store, [
      { jobClass: "unique-step", state: { step: "b" } },
    ]);
    await command.handle({ connection: "rec", sleep: "0", once: true });

    // The head still ran and was deleted; the duplicate link was not pushed.
    expect(runs).toEqual(["plain:head"]);
    expect(driver.deleted).toHaveLength(1);
    expect(driver.pushed).toEqual([]);
  });

  it("still pushes a chained link whose uniqueId differs", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    await holdLockFor(store, "unique-step", new UniqueStepJob("other"));

    const { command, driver } = workerFor(store, [
      { jobClass: "unique-step", state: { step: "b" } },
    ]);
    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed).toHaveLength(1);
    expect(driver.pushed[0]?.state).toEqual({ step: "b" });
  });

  it("never gates a non-unique chained link", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { command, driver } = workerFor(store, [
      { jobClass: "plain-step", state: { step: "b" } },
    ]);

    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed).toHaveLength(1);
  });

  it("carries the remaining chain forward when the link is pushed", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { command, driver } = workerFor(store, [
      { jobClass: "unique-step", state: { step: "b" } },
      { jobClass: "unique-step", state: { step: "c" } },
    ]);

    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed[0]?.options?.chain).toEqual([
      { jobClass: "unique-step", state: { step: "c" } },
    ]);
  });

  it("stops the chain (rather than throwing) when a link is unregistered", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { command, driver } = workerFor(store, [{ jobClass: "never-registered", state: {} }]);

    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed).toEqual([]);
    expect(driver.deleted).toHaveLength(1);
  });
});

describe("chained unique jobs — sync driver advance", () => {
  it("drops a chained link whose unique lock is already held", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    await holdLockFor(store, "unique-step", new UniqueStepJob("b"));

    const { app, registry } = buildApp(store);
    const driver = new SyncQueueDriver(app, registry);

    await driver.push(
      "plain-step",
      { step: "a" },
      {
        chain: [
          { jobClass: "unique-step", state: { step: "b" } },
          { jobClass: "plain-step", state: { step: "c" } },
        ],
      },
    );

    // "b" was dropped, and "c" rode behind it — the same all-or-nothing
    // the durable worker has, since the remainder travels on that push.
    expect(runs).toEqual(["plain:a"]);
  });

  it("runs every link when no lock is held, taking each link's lock in turn", async () => {
    const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
    const { app, registry } = buildApp(store);
    const driver = new SyncQueueDriver(app, registry);

    await driver.push(
      "plain-step",
      { step: "a" },
      {
        chain: [
          { jobClass: "unique-step", state: { step: "b" } },
          { jobClass: "unique-step", state: { step: "c" } },
        ],
      },
    );

    expect(runs).toEqual(["plain:a", "b", "c"]);
  });
});
