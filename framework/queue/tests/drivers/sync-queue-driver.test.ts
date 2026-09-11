import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import { Job } from "../../src/job.js";
import { JobRegistry } from "../../src/job-registry.js";
import { SyncQueueDriver } from "../../src/drivers/sync-queue-driver.js";

class GreetJob extends Job {
  static calls: unknown[] = [];

  constructor(public readonly name: string) {
    super();
  }

  handle(): void {
    GreetJob.calls.push({ name: this.name });
  }
}

class ThrowingJob extends Job {
  handle(): void {
    throw new Error("boom");
  }
}

describe("SyncQueueDriver", () => {
  it("push() runs the job inline and awaits it", async () => {
    GreetJob.calls = [];
    const app = new Application();
    const registry = new JobRegistry();
    registry.register("greet", GreetJob);
    const driver = new SyncQueueDriver(app, registry);

    await driver.push("greet", { name: "Ada" });

    expect(GreetJob.calls).toEqual([{ name: "Ada" }]);
  });

  it("a throwing job surfaces the error to the caller of push() (no retry logic applies to sync)", async () => {
    const app = new Application();
    const registry = new JobRegistry();
    registry.register("throwing", ThrowingJob);
    const driver = new SyncQueueDriver(app, registry);

    await expect(driver.push("throwing", {})).rejects.toThrow("boom");
  });

  it("pop() always returns undefined — nothing is ever queued for later", async () => {
    const app = new Application();
    const registry = new JobRegistry();
    const driver = new SyncQueueDriver(app, registry);

    expect(await driver.pop()).toBeUndefined();
  });
});
