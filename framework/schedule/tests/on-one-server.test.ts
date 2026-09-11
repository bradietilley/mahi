import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp } from "@mahi/core";
import { Schedule } from "../src/schedule.js";
import { ScheduledTask } from "../src/scheduled-task.js";
import { runDueTasks } from "../src/run-due-tasks.js";

/**
 * `onOneServer()` — running a task once per tick across several hosts,
 * rather than once per host.
 *
 * Simulated with two independent `Application`s pointed at one lock
 * directory, which is what two machines sharing a Redis (or an NFS mount)
 * amount to from the locker's point of view. Two `Schedule`s rather than
 * one, because the thing under test is precisely that two *separate*
 * schedulers reach the same conclusion about who runs.
 */
describe("onOneServer()", () => {
  let lockDirectory: string;

  beforeEach(async () => {
    lockDirectory = await mkdtemp(path.join(tmpdir(), "one-server-test-"));
  });

  afterEach(async () => {
    clearCurrentApp();
    await rm(lockDirectory, { recursive: true, force: true });
  });

  /** An app whose scheduler locks in the shared directory. */
  function makeHost(): Application {
    const app = new Application();
    app.config.set("schedule", { lockDirectory });

    return app;
  }

  /** A minute-granularity `* * * * *` task that records each run. */
  function countingSchedule(runs: string[], host: string, configure?: (t: ScheduledTask) => void) {
    const schedule = new Schedule();
    const task = schedule
      .call(() => {
        runs.push(host);
      })
      .name("shared-task");

    configure?.(task);

    return schedule;
  }

  const TICK = new Date("2026-03-04T05:06:00.000Z");

  it("runs on exactly one host for a given tick", async () => {
    const runs: string[] = [];
    const a = countingSchedule(runs, "a", (t) => t.onOneServer());
    const b = countingSchedule(runs, "b", (t) => t.onOneServer());

    await runDueTasks(makeHost(), a, TICK);
    await runDueTasks(makeHost(), b, TICK);

    expect(runs).toHaveLength(1);
  });

  it("runs on both hosts without it — the behaviour being fixed", async () => {
    // The control. Without onOneServer() a per-host scheduler runs the
    // task per host, which is correct for most tasks and catastrophic for
    // a billing job.
    const runs: string[] = [];
    const a = countingSchedule(runs, "a");
    const b = countingSchedule(runs, "b");

    await runDueTasks(makeHost(), a, TICK);
    await runDueTasks(makeHost(), b, TICK);

    expect(runs).toEqual(["a", "b"]);
  });

  it("does not block the next tick", async () => {
    // The lock is deliberately never released, so it must be scoped to
    // the minute — otherwise the first run would win forever and the task
    // would never run again until the expiry elapsed.
    const runs: string[] = [];
    const a = countingSchedule(runs, "a", (t) => t.onOneServer());
    const b = countingSchedule(runs, "b", (t) => t.onOneServer());

    await runDueTasks(makeHost(), a, TICK);
    await runDueTasks(makeHost(), b, TICK);

    const nextTick = new Date(TICK.getTime() + 60_000);
    await runDueTasks(makeHost(), a, nextTick);
    await runDueTasks(makeHost(), b, nextTick);

    expect(runs).toHaveLength(2);
  });

  it("gives two hosts the same key when their clocks differ by seconds", async () => {
    // Real hosts are never exactly in step. The key is minute-granular so
    // a few seconds of skew still resolves to one claim; if seconds were
    // included, both would claim and both would run.
    const task = new ScheduledTask(() => {}).name("t").onOneServer();

    const early = task.getOneServerKey(new Date("2026-03-04T05:06:01.000Z"));
    const late = task.getOneServerKey(new Date("2026-03-04T05:06:59.000Z"));

    expect(early).toBe(late);
    expect(early).toContain("202603040506");
  });

  it("keys different minutes apart", async () => {
    const task = new ScheduledTask(() => {}).name("t").onOneServer();

    expect(task.getOneServerKey(new Date("2026-03-04T05:06:00.000Z"))).not.toBe(
      task.getOneServerKey(new Date("2026-03-04T05:07:00.000Z")),
    );
  });

  it("keys different tasks apart", async () => {
    const first = new ScheduledTask(() => {}).name("first").onOneServer();
    const second = new ScheduledTask(() => {}).name("second").onOneServer();

    expect(first.getOneServerKey(TICK)).not.toBe(second.getOneServerKey(TICK));
  });

  it("returns no key when not enabled", () => {
    expect(new ScheduledTask(() => {}).name("t").getOneServerKey(TICK)).toBeUndefined();
  });

  it("combines with withoutOverlapping(), which uses a separate key", async () => {
    // They solve different problems — one host per tick, versus not
    // overlapping itself over time — so a task may want both, and their
    // locks must not collide.
    const task = new ScheduledTask(() => {}).name("t").onOneServer().withoutOverlapping();

    expect(task.runsOnOneServer()).toBe(true);
    expect(task.preventsOverlaps()).toBe(true);
    expect(task.getOneServerKey(TICK)).not.toBe(task.getOverlapKey());
  });

  it("rejects a non-positive expiry", () => {
    const task = new ScheduledTask(() => {}).name("t");

    expect(() => task.onOneServer(0)).toThrow(/expected a positive number of minutes/);
    expect(() => task.onOneServer(-1)).toThrow(/expected a positive number of minutes/);
    expect(() => task.onOneServer(Number.NaN)).toThrow(/expected a positive number of minutes/);
  });

  it("requires a name, since the name is the lock key", () => {
    const schedule = new Schedule();
    schedule.call(() => {}).onOneServer();

    expect(() => schedule.validate()).toThrow(/onOneServer\(\) but has no name/);
  });

  it("rejects two same-named tasks that would share the lock", () => {
    const schedule = new Schedule();
    schedule
      .call(() => {})
      .name("dupe")
      .onOneServer();
    schedule
      .call(() => {})
      .name("dupe")
      .onOneServer();

    expect(() => schedule.validate()).toThrow(/share/);
  });

  it("still runs a task whose filters pass, and skips one whose filters do not", async () => {
    // A filtered-out task must not consume the tick's claim: if it did,
    // a host that skips would stop the host that would have run.
    const runs: string[] = [];

    const skipping = new Schedule();
    skipping
      .call(() => {
        runs.push("skipped-host");
      })
      .name("shared-task")
      .onOneServer()
      .when(() => false);

    const running = countingSchedule(runs, "running-host", (t) => t.onOneServer());

    await runDueTasks(makeHost(), skipping, TICK);
    await runDueTasks(makeHost(), running, TICK);

    expect(runs).toEqual(["running-host"]);
  });
});
