import { describe, expect, it } from "vitest";
import { Tui } from "../src/tui.js";
import { ProgressBar } from "../src/progress.js";

describe("progress ProgressBar (manual control)", () => {
  it("starts at 0 progress", () => {
    const fake = Tui.fake([]);
    const bar = Tui.progress("Processing", 100);
    expect(bar.progress).toBe(0);
    expect(bar).toBeInstanceOf(ProgressBar);
    fake.restore();
  });

  it("advances progress by the given step", () => {
    const fake = Tui.fake([]);
    const bar = Tui.progress("Processing", 100);
    bar.start();
    bar.advance(10);
    expect(bar.progress).toBe(10);
    bar.finish();
    fake.restore();
  });

  it("clamps advance() so progress never exceeds total", () => {
    const fake = Tui.fake([]);
    const bar = Tui.progress("Processing", 10);
    bar.start();
    bar.advance(100);
    expect(bar.progress).toBe(10);
    bar.finish();
    fake.restore();
  });

  it("reaches 100% after finish() when fully advanced", () => {
    const fake = Tui.fake([]);
    const bar = Tui.progress("Processing", 4);
    bar.start();
    bar.advance();
    bar.advance();
    bar.advance();
    bar.advance();
    bar.finish();
    expect(bar.percentage()).toBe(1);
    fake.restore();
  });

  it("shows the label and fraction counter in the rendered output", () => {
    const fake = Tui.fake([]);
    const bar = Tui.progress("Uploading", 10);
    bar.start();
    bar.advance(3);
    bar.finish();
    const output = fake.strippedOutput();
    expect(output).toContain("Uploading");
    expect(output).toContain("3 / 10");
    fake.restore();
  });

  it("throws when total is 0 or less", () => {
    const fake = Tui.fake([]);
    expect(() => Tui.progress("Bad", 0)).toThrow();
    fake.restore();
  });
});

describe("progress Tui.progress auto-map overload", () => {
  it("returns results in order and calls the callback once per item", async () => {
    const fake = Tui.fake([]);
    const calls: number[] = [];
    const results = await Tui.progress("Mapping", [1, 2, 3], (item) => {
      calls.push(item);

      return item * 2;
    });
    expect(results).toEqual([2, 4, 6]);
    expect(calls).toEqual([1, 2, 3]);
    fake.restore();
  });

  it("advances the bar once per item and finishes at 100%", async () => {
    const fake = Tui.fake([]);
    let lastPercentage = 0;
    await Tui.progress("Mapping", [1, 2, 3, 4], (item, bar) => {
      lastPercentage = bar.percentage();

      return item;
    });
    // the callback observes percentage *before* its own advance() call
    expect(lastPercentage).toBe(0.75);
    fake.restore();
  });

  it("supports an async callback", async () => {
    const fake = Tui.fake([]);
    const results = await Tui.progress("Mapping", [1, 2], async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return item + 1;
    });
    expect(results).toEqual([2, 3]);
    fake.restore();
  });
});
