import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "@mahiframework/core";
import { ScheduleWorkCommand } from "../../src/commands/schedule-work.js";
import { Schedule } from "../../src/schedule.js";
import { SCHEDULE_TOKEN } from "../../src/tokens.js";

describe("ScheduleWorkCommand", () => {
  let dir: string;

  function makeApp(): { app: Application; schedule: Schedule } {
    const app = new Application();
    const schedule = new Schedule(app);
    app.config.set("schedule", { lockDirectory: dir });
    app.instance(SCHEDULE_TOKEN, schedule);
    vi.spyOn(app.logger, "info").mockImplementation(() => {});
    vi.spyOn(app.logger, "error").mockImplementation(() => {});
    vi.spyOn(app.logger, "warning").mockImplementation(() => {});

    return { app, schedule };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "schedule-work-test-"));
  });

  afterEach(async () => {
    // Unconditional, so a test that fails or times out cannot leave fake
    // timers installed for the next one — `withLoop()`'s own
    // `useRealTimers()` is in a `finally` that a timed-out body reaches
    // late, or never.
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("--once evaluates the schedule a single time and runs due tasks", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute();

    await new ScheduleWorkCommand(app).handle({ once: true });

    expect(calls).toEqual(["ran"]);
  });

  it("--once honours when()/skip() filters", async () => {
    const { app, schedule } = makeApp();

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("skipped");
      })
      .everyMinute()
      .skip(() => true);
    schedule
      .call(() => {
        calls.push("ran");
      })
      .everyMinute()
      .when(() => true);

    await new ScheduleWorkCommand(app).handle({ once: true });

    expect(calls).toEqual(["ran"]);
  });

  describe("the polling loop", () => {
    /**
     * Which `withLoop()` call is the live one.
     *
     * Vitest rejects a timed-out test's promise but does NOT abort the
     * async function behind it, so a timed-out body keeps executing —
     * detached — and eventually reaches its own cleanup while the NEXT
     * test is already in flight. That zombie cleanup used to
     * `process.emit("SIGINT")` (a global broadcast that stopped the new
     * test's loop, so it saw one tick instead of two) and advance fake
     * timers under the new test's feet. The result was a cascade:
     * one timeout failed two or three unrelated tests, and which ones
     * varied by run.
     *
     * A generation counter lets a stale cleanup detect that it has been
     * superseded and do nothing. Belt and braces alongside the raised
     * `testTimeout` — that removes the trigger, this contains the blast
     * radius if some future test is slow again.
     */
    let generation = 0;

    // These drive the loop with fake timers: `handle()` never resolves on
    // its own, so each test advances time, asserts, then trips the SIGINT
    // handler the command installs to let it finish.
    async function withLoop(
      app: Application,
      body: (advance: (ms: number) => Promise<void>) => Promise<void>,
    ): Promise<void> {
      const mine = ++generation;

      vi.useFakeTimers();
      const startedAt = new Date(2026, 0, 1, 10, 0, 0);
      vi.setSystemTime(startedAt);

      // Snapshot the process-global SIGINT listeners so the ones this
      // command installs can be invoked DIRECTLY at cleanup. Emitting the
      // signal would fan out to every listener on the process, including
      // another test's — which is precisely the leak described above.
      const before = new Set(process.listeners("SIGINT"));

      const command = new ScheduleWorkCommand(app);
      const running = command.handle({});

      // Let the loop reach its first sleep.
      await vi.advanceTimersByTimeAsync(0);

      const mySignalHandlers = process
        .listeners("SIGINT")
        .filter((listener) => !before.has(listener));

      const advance = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
      };

      try {
        await body(advance);
      } finally {
        // Stop only THIS command's loop.
        for (const handler of mySignalHandlers) {
          handler("SIGINT");
        }

        if (generation === mine) {
          // Let the loop observe the flag, exit, and drain in-flight ticks —
          // including any task timer still pending, which the shutdown
          // deliberately awaits. Generous, because these are fake timers:
          // advancing costs nothing in real time.
          await vi.advanceTimersByTimeAsync(10 * 60_000);
          await running;
          vi.useRealTimers();
        }
      }
    }

    it("evaluates once per wall-clock minute, not once per poll", async () => {
      const { app, schedule } = makeApp();

      let runs = 0;
      schedule.call(() => void runs++).everyMinute();

      await withLoop(app, async (advance) => {
        // The first tick fires immediately.
        expect(runs).toBe(1);
        // Four more polls within the same minute: still one run.
        await advance(4_000);
        expect(runs).toBe(1);
        // Crossing into the next minute fires again.
        await advance(60_000);
        expect(runs).toBe(2);
      });
    });

    it("still evaluates the next minute when a run takes longer than a minute", async () => {
      // Awaiting `runDueTasks()` inline would let a 90-second tick
      // swallow the minute after it entirely.
      const { app, schedule } = makeApp();

      const startedMinutes: number[] = [];
      schedule
        .call(async () => {
          startedMinutes.push(new Date().getMinutes());
          await new Promise((resolve) => setTimeout(resolve, 90_000));
        })
        .everyMinute();

      await withLoop(app, async (advance) => {
        expect(startedMinutes).toEqual([0]);
        // Minute 1: the first task is still running, but the loop is not
        // blocked on it, so this minute is evaluated on time.
        await advance(60_000);
        expect(startedMinutes).toEqual([0, 1]);
        await advance(60_000);
        expect(startedMinutes).toEqual([0, 1, 2]);
      });
    });

    it("does not fire twice for the same minute even after a long stall", async () => {
      // Keying off `getMinutes()` alone made minute 30 look new again an
      // hour later; keying off the absolute minute cannot.
      const { app, schedule } = makeApp();

      const runAt: number[] = [];
      schedule
        .call(() => {
          runAt.push(Date.now());
        })
        .everyMinute();

      await withLoop(app, async (advance) => {
        expect(runAt).toHaveLength(1);
        // Jump a full hour: exactly one new minute boundary is dispatched
        // per poll, and never the one already seen.
        await advance(60 * 60_000);
        expect(new Set(runAt).size).toBe(runAt.length);
      });
    });

    it("keeps looping when a tick's task throws", async () => {
      const { app, schedule } = makeApp();

      let runs = 0;
      schedule
        .call(() => {
          runs += 1;
          throw new Error("boom");
        })
        .everyMinute()
        .name("throwing");

      await withLoop(app, async (advance) => {
        expect(runs).toBe(1);
        await advance(60_000);
        expect(runs).toBe(2);
      });
    });

    it("waits for in-flight ticks before returning on shutdown", async () => {
      const { app, schedule } = makeApp();

      let finished = false;
      schedule
        .call(async () => {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          finished = true;
        })
        .everyMinute();

      await withLoop(app, async () => {
        expect(finished).toBe(false);
      });

      expect(finished).toBe(true);
    });
  });
});
