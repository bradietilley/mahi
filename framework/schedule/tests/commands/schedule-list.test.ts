import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { Tui } from "@mahi/tui";
import { ScheduleListCommand } from "../../src/commands/schedule-list.js";
import { Schedule } from "../../src/schedule.js";
import { SCHEDULE_TOKEN } from "../../src/tokens.js";

describe("ScheduleListCommand", () => {
  it("prints a table row for every registered task", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);
    schedule
      .call(() => {})
      .daily()
      .withDescription("prune-old-todos");

    const fake = Tui.fake([]);
    const command = new ScheduleListCommand(app);
    await command.handle();

    const output = fake.strippedOutput();
    expect(output).toContain("prune-old-todos");
    expect(output).toContain("0 0 * * *");
    // rendered as a bordered table, not a bare padded line
    expect(output).toContain("┌");
    expect(output).toContain("│");
    fake.restore();
  });

  it("includes the cron expression and next-due column headers", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);
    schedule
      .call(() => {})
      .hourly()
      .withDescription("send-digest");

    const fake = Tui.fake([]);
    const command = new ScheduleListCommand(app);
    await command.handle();

    const output = fake.strippedOutput();
    expect(output).toContain("Cron");
    expect(output).toContain("Description");
    expect(output).toContain("Next Due");
    fake.restore();
  });

  it("renders a zoned task's next-due in its own zone, labelled with it", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);
    schedule
      .call(() => {})
      .dailyAt("9:00")
      .timezone("Asia/Tokyo")
      .name("tokyo-digest");

    const fake = Tui.fake([]);
    await new ScheduleListCommand(app).handle();

    const output = fake.strippedOutput();
    // The whole point: the hour shown is the one in the expression, in the
    // zone it was written for — not the server's rendering of that instant.
    expect(output).toMatch(/\d{4}-\d{2}-\d{2} 09:00 Asia\/Tokyo/);
    fake.restore();
  });

  it("leaves an unzoned task's next-due unlabelled", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);
    schedule
      .call(() => {})
      .dailyAt("9:00")
      .name("local-digest");

    const fake = Tui.fake([]);
    await new ScheduleListCommand(app).handle();

    const output = fake.strippedOutput();
    expect(output).toMatch(/\d{4}-\d{2}-\d{2} 09:00/);
    expect(output).not.toContain("/");
    fake.restore();
  });

  it("prints an info message when no tasks are registered", async () => {
    const app = new Application();
    const schedule = new Schedule(app);
    app.instance(SCHEDULE_TOKEN, schedule);

    const fake = Tui.fake([]);
    const command = new ScheduleListCommand(app);
    await command.handle();

    expect(fake.strippedOutput()).toContain("No scheduled tasks registered.");
    fake.restore();
  });
});
