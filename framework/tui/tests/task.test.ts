import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/ansi/strip.js";
import { renderTaskLine } from "../src/task.js";
import { Tui } from "../src/tui.js";

describe("task renderTaskLine", () => {
  it("renders a DONE line with dots filling the remaining width", () => {
    const line = renderTaskLine("Creating migration table", "done", undefined, 80);
    const stripped = stripAnsi(line);
    expect(stripped).toMatch(/^ {2}Creating migration table \.+ DONE$/);
  });

  it("renders a FAIL line in red", () => {
    const line = renderTaskLine("Broken step", "failed", undefined, 80);
    expect(line).toContain("\x1b[31m"); // red
    expect(stripAnsi(line)).toContain("FAIL");
  });

  it("renders a SKIPPED line in yellow", () => {
    const line = renderTaskLine("Optional step", "skipped", undefined, 80);
    expect(line).toContain("\x1b[33m"); // yellow
    expect(stripAnsi(line)).toContain("SKIPPED");
  });

  it("renders DONE in green", () => {
    const line = renderTaskLine("Step", "done", undefined, 80);
    expect(line).toContain("\x1b[32m"); // green
  });

  it("includes a millisecond duration before the status word when given", () => {
    const line = renderTaskLine("Step", "done", 42, 80);
    expect(stripAnsi(line)).toContain("42ms DONE");
  });

  it("formats durations >= 1000ms in seconds", () => {
    const line = renderTaskLine("Step", "done", 1500, 80);
    expect(stripAnsi(line)).toContain("1.50s DONE");
  });

  it("shrinks the dotted fill as the terminal narrows, never going negative", () => {
    const line = renderTaskLine(
      "A very long migration name that takes up a lot of space",
      "done",
      undefined,
      40,
    );
    const stripped = stripAnsi(line);
    expect(stripped).not.toContain("..");
  });

  it("caps the dotted-fill width calculation at 150 columns even on a wider terminal", () => {
    const line80 = stripAnsi(renderTaskLine("Step", "done", undefined, 150));
    const line200 = stripAnsi(renderTaskLine("Step", "done", undefined, 200));
    expect(line80).toBe(line200);
  });
});

describe("task Tui.task()", () => {
  it("returns the callback's result", async () => {
    const fake = Tui.fake([]);
    const result = await Tui.task("Doing work", () => 42);
    expect(result).toBe(42);
    fake.restore();
  });

  it("shows RUNNING while in flight, then erases-and-rewrites the line to DONE once settled", async () => {
    const fake = Tui.fake([]);
    await Tui.task("Creating migration table", () => "ok");
    const output = fake.output();
    // BufferedOutput just appends (it doesn't emulate real terminal
    // erasure), so both the initial RUNNING write and the erase-and-
    // rewrite sequence show up in the raw buffer, assert the erase
    // escape code (\r + erase-line) appears between them, which is
    // what makes a real terminal show only the final DONE line.
    expect(output).toContain("RUNNING");
    expect(output).toContain("\r\x1b[K");
    expect(output).toContain("Creating migration table");
    expect(stripAnsi(output)).toContain("DONE");
    fake.restore();
  });

  it("shows FAIL and rethrows when the callback throws", async () => {
    const fake = Tui.fake([]);
    await expect(
      Tui.task("Risky step", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.strippedOutput()).toContain("FAIL");
    fake.restore();
  });

  it("supports an async callback", async () => {
    const fake = Tui.fake([]);
    const result = await Tui.task("Async step", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return "done-value";
    });
    expect(result).toBe("done-value");
    fake.restore();
  });

  it("prints multiple task lines back-to-back with no forced blank-line spacing", async () => {
    const fake = Tui.fake([]);
    await Tui.task("Step one", () => "a");
    await Tui.task("Step two", () => "b");
    const output = fake.strippedOutput();
    expect(output).not.toMatch(/\n\n\n/);
    expect(output).toContain("Step one");
    expect(output).toContain("Step two");
    fake.restore();
  });
});

describe("task Tui.taskLine()", () => {
  it("prints an already-settled status line", () => {
    const fake = Tui.fake([]);
    Tui.taskLine("Optional step", "skipped");
    expect(fake.strippedOutput()).toContain("SKIPPED");
    fake.restore();
  });
});
