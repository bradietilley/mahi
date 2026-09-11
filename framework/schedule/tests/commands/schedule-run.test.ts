import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "@mahi/core";
import { ScheduleRunCommand } from "../../src/commands/schedule-run.js";
import { Schedule } from "../../src/schedule.js";
import { SCHEDULE_TOKEN } from "../../src/tokens.js";
import { ScheduleLock } from "../../src/locking/schedule-lock.js";

const HOUR_MS = 60 * 60_000;

describe("ScheduleRunCommand", () => {
  let dir: string;

  /** An app with the schedule bound, a lock directory, and a silenced logger. */
  function makeApp(config: Record<string, unknown> = {}): { app: Application; schedule: Schedule } {
    const app = new Application();
    const schedule = new Schedule(app);
    app.config.set("schedule", { lockDirectory: dir, ...config });
    app.instance(SCHEDULE_TOKEN, schedule);
    vi.spyOn(app.logger, "error").mockImplementation(() => {});
    vi.spyOn(app.logger, "warning").mockImplementation(() => {});

    return { app, schedule };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "schedule-run-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs every due task", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("a");
      })
      .everyMinute();
    schedule
      .call(() => {
        calls.push("b");
      })
      .everyMinute();

    await new ScheduleRunCommand(app).handle();

    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("runs foreground tasks sequentially, in registration order", async () => {
    const { app, schedule } = makeApp();

    const order: string[] = [];
    schedule
      .call(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("slow");
      })
      .everyMinute();
    schedule
      .call(() => {
        order.push("fast");
      })
      .everyMinute();

    await new ScheduleRunCommand(app).handle();

    expect(order).toEqual(["slow", "fast"]);
  });

  it("one throwing task does not prevent a second due task from running", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        throw new Error("boom");
      })
      .everyMinute()
      .name("throwing-task");
    schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute()
      .name("second-task");

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual(["ran"]);
  });

  it("logs a failing task's stack, not just its message", async () => {
    const { app, schedule } = makeApp();
    const error = vi.mocked(app.logger.error);

    schedule
      .call(() => {
        throw new Error("boom");
      })
      .everyMinute()
      .name("throwing-task");

    await new ScheduleRunCommand(app).handle();

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[1]?.error).toBe("boom");
    expect(error.mock.calls[0]?.[1]?.stack).toContain("Error: boom");
  });

  it("a throwing when() filter is logged and skips only that task", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("filtered");
      })
      .everyMinute()
      .when(() => {
        throw new Error("filter blew up");
      });
    schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute();

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual(["ran"]);
    expect(vi.mocked(app.logger.error)).toHaveBeenCalledOnce();
  });

  it("skips a task whose overlap lock is already held", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    const task = schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute()
      .name("locked-task")
      .withoutOverlapping();

    await new ScheduleLock(dir).acquire(task.getOverlapKey()!, HOUR_MS);

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual([]);
    expect(vi.mocked(app.logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining("Skipping overlapping task"),
    );
  });

  it("does NOT skip a different task that merely shares a schedule", async () => {
    // The bug this whole plan starts from: both tasks defaulted to the
    // cron expression as their lock key, so locking one skipped the other.
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    const locked = schedule
      .call(() => {
        calls.push("locked");
      })
      .everyMinute()
      .name("task-a")
      .withoutOverlapping();
    schedule
      .call(() => {
        calls.push("unrelated");
      })
      .everyMinute()
      .name("task-b")
      .withoutOverlapping();

    await new ScheduleLock(dir).acquire(locked.getOverlapKey()!, HOUR_MS);

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual(["unrelated"]);
  });

  it("two concurrent runs of the same overlapping task run it exactly once", async () => {
    const { app, schedule } = makeApp();

    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    schedule
      .call(async () => {
        runs += 1;
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
      })
      .everyMinute()
      .name("exclusive")
      .withoutOverlapping();

    // Two `schedule:run` invocations in the same minute — what cron does
    // the moment a run overruns its slot.
    await Promise.all([new ScheduleRunCommand(app).handle(), new ScheduleRunCommand(app).handle()]);

    expect(runs).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it("skips a due task whose when() filter fails", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("filtered");
      })
      .everyMinute()
      .when(() => false);
    schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute();

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual(["ran"]);
  });

  it("skips a due task whose skip() filter triggers", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("nope");
      })
      .everyMinute()
      .skip(() => true);

    await new ScheduleRunCommand(app).handle();

    expect(calls).toEqual([]);
  });

  it("a filtered-out task never takes the lock", async () => {
    const { app, schedule } = makeApp();

    const task = schedule
      .call(() => {})
      .everyMinute()
      .name("filtered")
      .withoutOverlapping()
      .when(() => false);

    await new ScheduleRunCommand(app).handle();

    expect(await new ScheduleLock(dir).isLocked(task.getOverlapKey()!)).toBe(false);
  });

  it("releases the lock after a successful run", async () => {
    const { app, schedule } = makeApp();

    const task = schedule
      .call(() => {})
      .everyMinute()
      .name("cleanly-locked")
      .withoutOverlapping();

    await new ScheduleRunCommand(app).handle();

    expect(await new ScheduleLock(dir).isLocked(task.getOverlapKey()!)).toBe(false);
  });

  it("releases the lock after a failing run", async () => {
    const { app, schedule } = makeApp();

    const task = schedule
      .call(() => {
        throw new Error("boom");
      })
      .everyMinute()
      .name("failing-locked")
      .withoutOverlapping();

    await new ScheduleRunCommand(app).handle();

    expect(await new ScheduleLock(dir).isLocked(task.getOverlapKey()!)).toBe(false);
  });

  describe("runInBackground()", () => {
    it("does not delay the foreground tasks behind it", async () => {
      const { app, schedule } = makeApp();

      const order: string[] = [];
      schedule
        .call(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          order.push("background");
        })
        .everyMinute()
        .runInBackground();
      schedule
        .call(() => {
          order.push("foreground");
        })
        .everyMinute();

      await new ScheduleRunCommand(app).handle();

      // The background task started first but finished last, because the
      // foreground one didn't have to wait for it.
      expect(order).toEqual(["foreground", "background"]);
    });

    it("is still awaited before the run finishes", async () => {
      const { app, schedule } = makeApp();

      let finished = false;
      schedule
        .call(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          finished = true;
        })
        .everyMinute()
        .runInBackground();

      await new ScheduleRunCommand(app).handle();

      expect(finished).toBe(true);
    });

    it("a throwing background task does not fail the run", async () => {
      const { app, schedule } = makeApp();

      const calls: string[] = [];
      schedule
        .call(async () => {
          throw new Error("boom");
        })
        .everyMinute()
        .name("bad-background")
        .runInBackground();
      schedule
        .call(() => {
          calls.push("ran");
        })
        .everyMinute();

      await expect(new ScheduleRunCommand(app).handle()).resolves.toBeUndefined();
      expect(calls).toEqual(["ran"]);
    });

    it("background tasks run concurrently with each other", async () => {
      const { app, schedule } = makeApp();

      let running = 0;
      let maxConcurrent = 0;

      for (let i = 0; i < 3; i++) {
        schedule
          .call(async () => {
            running += 1;
            maxConcurrent = Math.max(maxConcurrent, running);
            await new Promise((resolve) => setTimeout(resolve, 30));
            running -= 1;
          })
          .everyMinute()
          .runInBackground();
      }

      await new ScheduleRunCommand(app).handle();

      expect(maxConcurrent).toBe(3);
    });
  });

  describe("unevaluatable expressions", () => {
    it("logs the task and still runs its siblings", async () => {
      const { app, schedule } = makeApp();

      const calls: string[] = [];
      const broken = schedule
        .call(() => {
          calls.push("broken");
        })
        .everyMinute();
      Object.defineProperty(broken, "isDueAt", {
        value: () => {
          throw new Error("unparseable");
        },
      });
      schedule
        .call(() => {
          calls.push("ran");
        })
        .everyMinute();

      await new ScheduleRunCommand(app).handle();

      expect(calls).toEqual(["ran"]);
      expect(vi.mocked(app.logger.error)).toHaveBeenCalledWith(
        expect.stringContaining("could not be evaluated"),
        expect.objectContaining({ error: "unparseable" }),
      );
    });
  });

  describe("lockStore configuration", () => {
    it("uses a configured cache store for overlap locks", async () => {
      const entries = new Map<string, unknown>();
      const added: string[] = [];
      // Named as if it were the Redis store, since `resolveLocker()`
      // refuses in-memory ones by class name.
      class RedisCacheStore {
        async add(key: string, value: unknown): Promise<boolean> {
          added.push(key);

          if (entries.has(key)) {
            return false;
          }

          entries.set(key, value);

          return true;
        }
        async get(key: string): Promise<unknown> {
          return entries.get(key);
        }
        async forget(key: string): Promise<void> {
          entries.delete(key);
        }
      }

      const { app, schedule } = makeApp({ lockStore: "redis" });
      app.instance("cache", { store: () => new RedisCacheStore() });

      let runs = 0;
      schedule
        .call(async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        })
        .everyMinute()
        .name("shared")
        .withoutOverlapping();

      await Promise.all([
        new ScheduleRunCommand(app).handle(),
        new ScheduleRunCommand(app).handle(),
      ]);

      // The store was consulted — not silently bypassed for lock files —
      // and it, not the filesystem, is what serialised the two runs.
      expect(added).toEqual(["schedule-overlap:shared_lock", "schedule-overlap:shared_lock"]);
      expect(await readdir(dir)).toEqual([]);
      expect(runs).toBe(1);
      expect(entries.size).toBe(0); // released
      // The only warning is the legitimate skip, not a fallback notice.
      expect(vi.mocked(app.logger.warning).mock.calls.map((call) => call[0])).toEqual([
        "Skipping overlapping task: shared",
      ]);
    });

    it("warns and falls back to files when the cache is not registered", async () => {
      const { app, schedule } = makeApp({ lockStore: "redis" });

      const calls: string[] = [];
      schedule
        .call(() => {
          calls.push("ran");
        })
        .everyMinute()
        .name("t")
        .withoutOverlapping();

      await new ScheduleRunCommand(app).handle();

      expect(calls).toEqual(["ran"]);
      expect(vi.mocked(app.logger.warning)).toHaveBeenCalledWith(
        expect.stringContaining("no cache is registered"),
      );
    });

    it("refuses an in-memory store, which cannot lock across processes", async () => {
      // An in-memory `add()` always succeeds in a fresh process, so using
      // it would turn overlap prevention into a no-op that merely LOOKS
      // configured. Lock files are strictly better, and are what should be
      // used instead.
      let consulted = 0;
      class ArrayCacheStore {
        async add(): Promise<boolean> {
          consulted += 1;

          return true;
        }
        async get(): Promise<undefined> {
          return undefined;
        }
        async forget(): Promise<void> {}
      }

      const { app, schedule } = makeApp({ lockStore: "array" });
      app.instance("cache", { store: () => new ArrayCacheStore() });

      let runs = 0;
      schedule
        .call(async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        })
        .everyMinute()
        .name("t")
        .withoutOverlapping();

      await Promise.all([
        new ScheduleRunCommand(app).handle(),
        new ScheduleRunCommand(app).handle(),
      ]);

      expect(vi.mocked(app.logger.warning)).toHaveBeenCalledWith(
        expect.stringContaining("cannot lock across processes"),
      );
      expect(consulted).toBe(0);
      // Files did the locking, and did it correctly.
      expect(runs).toBe(1);
    });

    it("warns and falls back when the named store cannot be resolved", async () => {
      const { app, schedule } = makeApp({ lockStore: "nope" });
      app.instance("cache", {
        store: () => {
          throw new Error("no such store");
        },
      });

      const calls: string[] = [];
      schedule
        .call(() => {
          calls.push("ran");
        })
        .everyMinute()
        .name("t")
        .withoutOverlapping();

      await new ScheduleRunCommand(app).handle();

      expect(calls).toEqual(["ran"]);
      expect(vi.mocked(app.logger.warning)).toHaveBeenCalledWith(
        expect.stringContaining('Could not resolve cache store "nope"'),
        expect.anything(),
      );
    });
  });
});
