import { Application } from "@mahiframework/core";
import { describe, expect, it } from "vitest";
import { Schedule, type ScheduleEvaluationError } from "../src/schedule.js";

describe("Schedule", () => {
  it("call() registers a task and returns it for fluent configuration", () => {
    const schedule = new Schedule(new Application());
    const task = schedule.call(() => {}).hourly();
    expect(schedule.all()).toContain(task);
  });

  it("dueTasks() filters to only tasks due at the given time", () => {
    const schedule = new Schedule(new Application());
    const hourlyTask = schedule.call(() => {}).hourly();
    const dailyTask = schedule.call(() => {}).daily();

    const due = schedule.dueTasks(new Date(2026, 0, 1, 5, 0)); // top of the hour, not midnight
    expect(due).toContain(hourlyTask);
    expect(due).not.toContain(dailyTask);
  });

  it("all() returns every registered task regardless of due status", () => {
    const schedule = new Schedule(new Application());
    schedule.call(() => {}).hourly();
    schedule.call(() => {}).daily();
    expect(schedule.all()).toHaveLength(2);
  });

  it("job() throws a clear error when no queue provider is registered", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    const task = schedule.job(() => ({ handle() {} }));

    await expect(task.run(app)).rejects.toThrow(/QueueServiceProvider/);
  });

  it("job() dispatches a freshly-built job through the resolved QueueManager", async () => {
    const app = new Application();
    const dispatched: unknown[] = [];
    app.instance("queue", {
      dispatch: async (job: unknown) => {
        dispatched.push(job);
      },
    });

    const sendReport = { handle() {} };
    let built = 0;
    const schedule = new Schedule(app);
    const task = schedule.job(() => {
      built += 1;

      return sendReport;
    });

    await task.run(app);

    // Exactly one build per run: the name defaults to the cron expression
    // for an object literal, so no extra probing build happens either.
    expect(built).toBe(1);
    expect(dispatched).toEqual([sendReport]);
  });

  describe("job() naming", () => {
    class PrunePostsJob {
      handle(): void {}
    }

    it("defaults the task's name to the job class name", () => {
      const schedule = new Schedule(new Application());
      const task = schedule.job(() => new PrunePostsJob());
      expect(task.getName()).toBe("PrunePostsJob");
    });

    it("gives two different job classes distinct names, and so distinct overlap keys", () => {
      class SendDigestJob {
        handle(): void {}
      }

      const schedule = new Schedule(new Application());
      const a = schedule.job(() => new PrunePostsJob()).withoutOverlapping();
      const b = schedule.job(() => new SendDigestJob()).withoutOverlapping();

      expect(a.getOverlapKey()).not.toBe(b.getOverlapKey());
      expect(() => schedule.validate()).not.toThrow();
    });

    it("name() overrides the default and the factory is never probed", () => {
      let built = 0;
      const schedule = new Schedule(new Application());
      const task = schedule
        .job(() => {
          built += 1;

          return new PrunePostsJob();
        })
        .name("prune-posts");

      expect(task.getName()).toBe("prune-posts");
      expect(built).toBe(0);
    });

    it("does not invoke the factory at registration", () => {
      let built = 0;
      const schedule = new Schedule(new Application());
      schedule.job(() => {
        built += 1;

        return new PrunePostsJob();
      });
      expect(built).toBe(0);
    });

    it("probes the factory at most once, however often the name is read", () => {
      let built = 0;
      const schedule = new Schedule(new Application());
      const task = schedule.job(() => {
        built += 1;

        return new PrunePostsJob();
      });

      task.getName();
      task.getName();
      task.getDescription();

      expect(built).toBe(1);
    });

    it("falls back to the cron expression for an object literal with no class", () => {
      const schedule = new Schedule(new Application());
      const task = schedule.job(() => ({ handle() {} })).daily();
      expect(task.getName()).toBeUndefined();
      expect(task.getDescription()).toBe("0 0 * * *");
    });

    it("survives a factory that throws while being probed", () => {
      const schedule = new Schedule(new Application());
      const task = schedule
        .job(() => {
          throw new Error("needs a request-scoped binding");
        })
        .daily();

      expect(task.getName()).toBeUndefined();
      expect(task.getDescription()).toBe("0 0 * * *");
    });
  });

  describe("dueTasks() error isolation", () => {
    it("excludes and reports a task whose expression cannot be evaluated", () => {
      const schedule = new Schedule(new Application());

      const good = schedule.call(() => {}).everyMinute();
      const broken = schedule.call(() => {}).everyMinute();
      // Only reachable by forcing it: `cron()` validates eagerly now.
      Object.defineProperty(broken, "isDueAt", {
        value: () => {
          throw new Error("boom");
        },
      });

      const errors: ScheduleEvaluationError[] = [];
      const due = schedule.dueTasks(new Date(2026, 0, 1, 0, 0), errors);

      expect(due).toEqual([good]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.task).toBe(broken);
      expect(errors[0]?.error.message).toBe("boom");
    });

    it("does not require an errors array", () => {
      const schedule = new Schedule(new Application());
      const broken = schedule.call(() => {}).everyMinute();
      Object.defineProperty(broken, "isDueAt", {
        value: () => {
          throw new Error("boom");
        },
      });

      expect(() => schedule.dueTasks(new Date())).not.toThrow();
      expect(schedule.dueTasks(new Date())).toEqual([]);
    });
  });

  describe("validate()", () => {
    it("throws for an unnamed task using withoutOverlapping()", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .everyMinute()
        .withoutOverlapping();

      expect(() => schedule.validate()).toThrow(/withoutOverlapping\(\) but has no name/);
    });

    it("names the offending expression in the error", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .daily()
        .withoutOverlapping();

      expect(() => schedule.validate()).toThrow(/"0 0 \* \* \*"/);
    });

    it("accepts named tasks using withoutOverlapping()", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .everyMinute()
        .name("a")
        .withoutOverlapping();
      schedule
        .call(() => {})
        .everyMinute()
        .name("b")
        .withoutOverlapping();

      expect(() => schedule.validate()).not.toThrow();
    });

    it("accepts withoutOverlapping() called before name()", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .everyMinute()
        .withoutOverlapping()
        .name("a");

      expect(() => schedule.validate()).not.toThrow();
    });

    it("throws when two overlap-preventing tasks share a name", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .everyMinute()
        .name("sync")
        .withoutOverlapping();
      schedule
        .call(() => {})
        .hourly()
        .name("sync")
        .withoutOverlapping();

      expect(() => schedule.validate()).toThrow(/Two scheduled tasks named "sync"/);
    });

    it("allows duplicate names on tasks that do not prevent overlaps", () => {
      const schedule = new Schedule(new Application());
      schedule
        .call(() => {})
        .everyMinute()
        .name("sync");
      schedule
        .call(() => {})
        .hourly()
        .name("sync");

      expect(() => schedule.validate()).not.toThrow();
    });

    it("allows unnamed tasks that do not prevent overlaps", () => {
      const schedule = new Schedule(new Application());
      schedule.call(() => {}).everyMinute();
      schedule.call(() => {}).everyMinute();

      expect(() => schedule.validate()).not.toThrow();
    });
  });
});
