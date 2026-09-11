import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { Tui } from "@mahi/tui";

// Raw terminal keystrokes (not re-exported from @mahi/tui's public
// surface) — a fake select() is driven by navigation + Enter, so we inline
// the two we need.
const DOWN = "\x1b[B";
const ENTER = "\r";
import { ScheduleTestCommand } from "../../src/commands/schedule-test.js";
import { Schedule } from "../../src/schedule.js";
import { SCHEDULE_TOKEN } from "../../src/tokens.js";

describe("ScheduleTestCommand", () => {
  it("runs the interactively-selected task", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);

    const calls: string[] = [];
    schedule
      .call(() => {
        calls.push("first");
      })
      .daily()
      .withDescription("first-task");
    schedule
      .call(() => {
        calls.push("second");
      })
      .daily()
      .withDescription("second-task");

    // Navigate down once (to the second option) then Enter.
    const fake = Tui.fake([DOWN, ENTER]);
    const command = new ScheduleTestCommand(app);
    await command.handle();

    expect(calls).toEqual(["second"]);
    fake.restore();
  });

  it("prints an info message when no tasks are registered", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);

    const fake = Tui.fake([]);
    const command = new ScheduleTestCommand(app);
    await command.handle();

    expect(fake.strippedOutput()).toContain("No scheduled tasks registered.");
    fake.restore();
  });

  it("reports a task failure without throwing", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);

    schedule
      .call(() => {
        throw new Error("kaboom");
      })
      .daily()
      .withDescription("bad-task");

    const fake = Tui.fake([ENTER]);
    const command = new ScheduleTestCommand(app);
    await expect(command.handle()).resolves.toBeUndefined();

    expect(fake.strippedOutput()).toContain("kaboom");
    fake.restore();
  });
});
