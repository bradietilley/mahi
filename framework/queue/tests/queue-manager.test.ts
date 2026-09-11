import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import { QueueManager } from "../src/queue-manager.js";
import { JobRegistry } from "../src/job-registry.js";
import { Job } from "../src/job.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { JOB_REGISTRY_TOKEN } from "../src/tokens.js";

class RecordJob extends Job {
  static received: unknown[] = [];
  constructor(public readonly value: unknown) {
    super();
  }
  handle(): void {
    RecordJob.received.push(this.value);
  }
}

function buildManager(): { manager: QueueManager; registry: JobRegistry } {
  const app = new Application();
  const registry = new JobRegistry();
  registry.register("record", RecordJob);
  app.instance(JOB_REGISTRY_TOKEN, registry);
  const manager = new QueueManager(app, { default: "sync", connections: { sync: {} } });
  manager.extend("sync", () => new SyncQueueDriver(app, registry));

  return { manager, registry };
}

describe("QueueManager", () => {
  it("connection() resolves the default connection when called without a name", () => {
    const { manager } = buildManager();
    expect(manager.connection()).toBeInstanceOf(SyncQueueDriver);
  });

  it("connection() resolves and caches the same instance across calls", () => {
    const { manager } = buildManager();
    expect(manager.connection()).toBe(manager.connection());
  });

  it("dispatch() pushes a job instance onto the resolved driver", async () => {
    RecordJob.received = [];
    const { manager } = buildManager();

    await manager.dispatch(new RecordJob({ hello: "world" }));

    expect(RecordJob.received).toEqual([{ hello: "world" }]);
  });
});
