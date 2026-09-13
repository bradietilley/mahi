import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import { QueueServiceProvider } from "../src/queue-service-provider.js";
import { Job } from "../src/job.js";
import { Bus } from "../src/bus-facade.js";

class PingJob extends Job {
  static calls = 0;
  handle(): void {
    PingJob.calls += 1;
  }
}

describe("Bus facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("dispatch() runs the named job on the current app()'s QueueManager (sync connection)", async () => {
    PingJob.calls = 0;

    const app = new Application();
    app.config.set("queue", { default: "sync", connections: { sync: {} } });
    app.register(QueueServiceProvider);
    // Mirrors how a real feature provider contributes jobs(). See
    // TodosServiceProvider.
    class TodosLikeProvider extends ServiceProvider {
      jobs() {
        return { ping: PingJob };
      }
    }
    app.register(TodosLikeProvider);
    await app.bootstrap();

    await Bus.dispatch(new PingJob());

    expect(PingJob.calls).toBe(1);
  });

  it("throws app()'s own error when no Application has bootstrapped yet", () => {
    expect(() => Bus.dispatch(new PingJob())).toThrow(
      /No Application instance is currently registered/,
    );
  });
});
