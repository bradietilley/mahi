import { describe, expect, it } from "vitest";
import { Application, ServiceProvider } from "@mahi/core";
import { DatabaseServiceProvider } from "@mahi/database";
import {
  QueueServiceProvider,
  QUEUE_TOKEN,
  JOB_REGISTRY_TOKEN,
} from "../src/queue-service-provider.js";
import { QueueManager } from "../src/queue-manager.js";
import { JobRegistry } from "../src/job-registry.js";
import { Job } from "../src/job.js";
import { SyncQueueDriver } from "../src/drivers/sync-queue-driver.js";
import { DatabaseQueueDriver } from "../src/drivers/database-queue-driver.js";

class PingJob extends Job {
  static calls = 0;
  handle(): void {
    PingJob.calls += 1;
  }
}

class TodosLikeProvider extends ServiceProvider {
  jobs() {
    return { ping: PingJob };
  }
}

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    connections: { sqlite: { filename: ":memory:" } },
  });
  app.config.set("queue", { default: "sync", connections: { sync: {}, database: {} } });
  app.register(DatabaseServiceProvider);
  app.register(QueueServiceProvider);
  app.register(TodosLikeProvider);
  await app.bootstrap();

  return app;
}

describe("QueueServiceProvider", () => {
  it("registers a QueueManager singleton resolving the configured default connection", async () => {
    const app = await buildApp();
    const manager = app.make<QueueManager>(QUEUE_TOKEN);
    expect(manager.connection()).toBeInstanceOf(SyncQueueDriver);
  });

  it("registers a 'database' connection backed by DatabaseQueueDriver", async () => {
    const app = await buildApp();
    const manager = app.make<QueueManager>(QUEUE_TOKEN);
    expect(manager.connection("database")).toBeInstanceOf(DatabaseQueueDriver);
  });

  it("collects jobs() from every registered provider into the JobRegistry", async () => {
    const app = await buildApp();
    const registry = app.make<JobRegistry>(JOB_REGISTRY_TOKEN);
    expect(registry.has("ping")).toBe(true);
  });

  it("dispatch() on the sync connection actually runs the registered job", async () => {
    PingJob.calls = 0;
    const app = await buildApp();
    const manager = app.make<QueueManager>(QUEUE_TOKEN);

    await manager.dispatch(new PingJob());

    expect(PingJob.calls).toBe(1);
  });

  it("contributes static migration sources for the jobs/failed_jobs tables", async () => {
    const app = await buildApp();
    const provider = app.getProviders().find((p) => p instanceof QueueServiceProvider);
    const sources = provider?.migrationSources?.() ?? [];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => typeof s !== "string" && "name" in s)).toBe(true);
  });
});
