import { describe, expect, it } from "vitest";
import { Tui } from "../src/tui.js";
import { Key } from "../src/terminal/key.js";

describe("confirm", () => {
  it("defaults to true (Yes) when Enter is pressed immediately", async () => {
    const fake = Tui.fake([Key.ENTER]);
    const result = await Tui.confirm("Are you sure?");
    expect(result).toBe(true);
    fake.restore();
  });

  it("respects an explicit default of false", async () => {
    const fake = Tui.fake([Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: false });
    expect(result).toBe(false);
    fake.restore();
  });

  it("returns true when 'y' is pressed then Enter", async () => {
    const fake = Tui.fake(["y", Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: false });
    expect(result).toBe(true);
    fake.restore();
  });

  it("returns false when 'n' is pressed then Enter", async () => {
    const fake = Tui.fake(["n", Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: true });
    expect(result).toBe(false);
    fake.restore();
  });

  it("toggles the current value with the left/right arrow keys", async () => {
    const fake = Tui.fake([Key.LEFT, Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: true });
    expect(result).toBe(false);
    fake.restore();
  });

  it("toggles with Tab", async () => {
    const fake = Tui.fake([Key.TAB, Key.TAB, Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: true });
    expect(result).toBe(true);
    fake.restore();
  });

  it("supports vim-style h/l toggling", async () => {
    const fake = Tui.fake(["h", Key.ENTER]);
    const result = await Tui.confirm("Are you sure?", { default: true });
    expect(result).toBe(false);
    fake.restore();
  });

  it("shows the label in the rendered output", async () => {
    const fake = Tui.fake([Key.ENTER]);
    await Tui.confirm("Delete everything?");
    expect(fake.strippedOutput()).toContain("Delete everything?");
    fake.restore();
  });

  it("shows custom yes/no labels in the rendered output", async () => {
    const fake = Tui.fake([Key.ENTER]);
    await Tui.confirm("Proceed?", { yes: "Absolutely", no: "No way" });
    expect(fake.strippedOutput()).toContain("Absolutely");
    expect(fake.strippedOutput()).toContain("No way");
    fake.restore();
  });

  it("runs a custom validator and blocks submission until it passes", async () => {
    const fake = Tui.fake([Key.ENTER, "y", Key.ENTER]);
    const result = await Tui.confirm("Confirm?", {
      default: false,
      validate: (v) => (v ? undefined : "You must confirm."),
    });
    expect(result).toBe(true);
    expect(fake.strippedOutput()).toContain("You must confirm.");
    fake.restore();
  });
});
