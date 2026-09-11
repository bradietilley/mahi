import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import { Job } from "../src/job.js";
import { JobRegistry } from "../src/job-registry.js";
import { QueueManager } from "../src/queue-manager.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { FakeQueueDriver } from "../src/drivers/fake-queue-driver.js";
import { QueueWorkCommand } from "../src/commands/queue-work.js";
import { QUEUE_TOKEN, JOB_REGISTRY_TOKEN } from "../src/tokens.js";
import type { JobState } from "../src/job-serialization.js";
import type { QueueDriver, QueuedJob, PushOptions } from "../src/queue-driver.js";

const order: string[] = [];

class StepJob extends Job {
  constructor(public readonly step: string) {
    super();
  }
  handle(): void {
    order.push(this.step);
  }
}

function appWith(registry: JobRegistry): Application {
  const app = new Application();
  app.instance(JOB_REGISTRY_TOKEN, registry);

  return app;
}

describe("job chaining — sync driver", () => {
  it("runs every link inline, in order", async () => {
    order.length = 0;
    const registry = new JobRegistry();
    registry.register("step", StepJob);
    const app = appWith(registry);
    const driver = new SyncQueueDriver(app, registry);

    await driver.push(
      "step",
      { step: "a" },
      {
        chain: [
          { jobClass: "step", state: { step: "b" } },
          { jobClass: "step", state: { step: "c" } },
        ],
      },
    );

    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("job chaining — fake driver", () => {
  it("records the chain attached to the pushed job", async () => {
    const driver = new FakeQueueDriver();
    await driver.push(
      "step",
      { step: "a" },
      {
        chain: [{ jobClass: "step", state: { step: "b" } }],
      },
    );

    const [pushed] = driver.pushed("step");
    expect(pushed?.chain).toEqual([{ jobClass: "step", state: { step: "b" } }]);
  });
});

describe("QueueManager.chain()", () => {
  it("dispatches the first link with the rest attached", async () => {
    const registry = new JobRegistry();
    registry.register("step", StepJob);
    const app = appWith(registry);
    const driver = new FakeQueueDriver();
    const manager = new QueueManager(app, { default: "fake", connections: { fake: {} } });
    manager.extend("fake", () => driver);

    await manager.chain([new StepJob("a"), new StepJob("b"), new StepJob("c")]);

    const [pushed] = driver.pushed("step");
    expect(pushed?.state).toEqual({ step: "a" });
    expect(pushed?.chain).toEqual([
      { jobClass: "step", state: { step: "b" } },
      { jobClass: "step", state: { step: "c" } },
    ]);
  });

  it("is a no-op for an empty chain", async () => {
    const registry = new JobRegistry();
    const app = appWith(registry);
    const driver = new FakeQueueDriver();
    const manager = new QueueManager(app, { default: "fake", connections: { fake: {} } });
    manager.extend("fake", () => driver);

    await manager.chain([]);
    expect(driver.pushed()).toEqual([]);
  });
});

/** A driver that plays back pre-seeded jobs and records pushes (for chain advancement). */
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

describe("job chaining — worker advances the chain on success", () => {
  it("dispatches the next link (carrying the remainder) after a job succeeds", async () => {
    order.length = 0;
    const registry = new JobRegistry();
    registry.register("step", StepJob);

    const job: QueuedJob = {
      id: "1",
      jobClass: "step",
      state: { step: "a" },
      attempts: 0,
      chain: [
        { jobClass: "step", state: { step: "b" } },
        { jobClass: "step", state: { step: "c" } },
      ],
    };
    const driver = new RecordingDriver([job]);
    const app = appWith(registry);
    const manager = new QueueManager(app, { default: "rec", connections: { rec: {} } });
    manager.extend("rec", () => driver);
    app.instance(QUEUE_TOKEN, manager);

    const command = new QueueWorkCommand(app);
    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(order).toEqual(["a"]);
    expect(driver.deleted).toEqual([job]);
    expect(driver.pushed).toHaveLength(1);
    expect(driver.pushed[0]?.jobClass).toBe("step");
    expect(driver.pushed[0]?.state).toEqual({ step: "b" });
    expect(driver.pushed[0]?.options?.chain).toEqual([{ jobClass: "step", state: { step: "c" } }]);
  });

  it("does not dispatch anything further for the last link in a chain", async () => {
    order.length = 0;
    const registry = new JobRegistry();
    registry.register("step", StepJob);

    const job: QueuedJob = { id: "1", jobClass: "step", state: { step: "z" }, attempts: 0 };
    const driver = new RecordingDriver([job]);
    const app = appWith(registry);
    const manager = new QueueManager(app, { default: "rec", connections: { rec: {} } });
    manager.extend("rec", () => driver);
    app.instance(QUEUE_TOKEN, manager);

    const command = new QueueWorkCommand(app);
    await command.handle({ connection: "rec", sleep: "0", once: true });

    expect(driver.pushed).toEqual([]);
    expect(driver.deleted).toEqual([job]);
  });
});
