import { describe, expect, it } from "vitest";
import { Application, ServiceProvider } from "@mahi/core";
import { ScheduleServiceProvider, SCHEDULE_TOKEN } from "../src/schedule-service-provider.js";
import { Schedule } from "../src/schedule.js";

class TodosLikeProvider extends ServiceProvider {
  schedule(schedule: Schedule): void {
    schedule
      .call(() => {})
      .daily()
      .withDescription("prune-old-todos");
  }
}

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.register(ScheduleServiceProvider);
  app.register(TodosLikeProvider);
  await app.bootstrap();

  return app;
}

describe("ScheduleServiceProvider", () => {
  it("registers a Schedule singleton", async () => {
    const app = await buildApp();
    expect(app.make<Schedule>(SCHEDULE_TOKEN)).toBeInstanceOf(Schedule);
  });

  it("collects schedule() hooks from every registered provider during boot", async () => {
    const app = await buildApp();
    const schedule = app.make<Schedule>(SCHEDULE_TOKEN);
    expect(schedule.all()).toHaveLength(1);
    expect(schedule.all()[0]!.getDescription()).toBe("prune-old-todos");
  });

  describe("validation at boot", () => {
    // Failing here is the point: an unnamed `withoutOverlapping()` task is
    // a "this task mysteriously stopped running" bug in production, and
    // boot is the moment the mistake is cheapest to find.
    it("rejects an unnamed task using withoutOverlapping()", async () => {
      class BadProvider extends ServiceProvider {
        schedule(schedule: Schedule): void {
          schedule
            .call(() => {})
            .daily()
            .withoutOverlapping();
        }
      }

      const app = new Application();
      app.register(ScheduleServiceProvider);
      app.register(BadProvider);

      await expect(app.bootstrap()).rejects.toThrow(/withoutOverlapping\(\) but has no name/);
    });

    it("rejects two overlap-preventing tasks contributed by different providers under one name", async () => {
      class OneProvider extends ServiceProvider {
        schedule(schedule: Schedule): void {
          schedule
            .call(() => {})
            .daily()
            .name("sync")
            .withoutOverlapping();
        }
      }
      class AnotherProvider extends ServiceProvider {
        schedule(schedule: Schedule): void {
          schedule
            .call(() => {})
            .hourly()
            .name("sync")
            .withoutOverlapping();
        }
      }

      const app = new Application();
      app.register(ScheduleServiceProvider);
      app.register(OneProvider);
      app.register(AnotherProvider);

      await expect(app.bootstrap()).rejects.toThrow(/Two scheduled tasks named "sync"/);
    });

    it("accepts a correctly-named overlapping task", async () => {
      class GoodProvider extends ServiceProvider {
        schedule(schedule: Schedule): void {
          schedule
            .call(() => {})
            .daily()
            .name("auth-gc")
            .withoutOverlapping();
        }
      }

      const app = new Application();
      app.register(ScheduleServiceProvider);
      app.register(GoodProvider);

      await expect(app.bootstrap()).resolves.not.toThrow();
      expect(app.make<Schedule>(SCHEDULE_TOKEN).all()).toHaveLength(1);
    });
  });
});
