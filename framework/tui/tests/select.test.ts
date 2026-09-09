import { describe, expect, it } from "vitest";
import { Tui } from "../src/tui.js";
import { Key } from "../src/terminal/key.js";

describe("select", () => {
  it("returns the highlighted (first, by default) option on Enter", async () => {
    const fake = Tui.fake([Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("local");
    fake.restore();
  });

  it("navigates down with the down arrow key", async () => {
    const fake = Tui.fake([Key.DOWN, Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("navigates up with the up arrow key", async () => {
    const fake = Tui.fake([Key.DOWN, Key.DOWN, Key.UP, Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("supports vim-style j/k navigation", async () => {
    const fake = Tui.fake(["j", "j", "k", Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("wraps around from the last option back to the first with down", async () => {
    const fake = Tui.fake([Key.DOWN, Key.DOWN, Key.DOWN, Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("local");
    fake.restore();
  });

  it("wraps around from the first option to the last with up", async () => {
    const fake = Tui.fake([Key.UP, Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("production");
    fake.restore();
  });

  it("navigates with Tab/Shift+Tab", async () => {
    const fake = Tui.fake([Key.TAB, Key.TAB, Key.SHIFT_TAB, Key.ENTER]);
    const result = await Tui.select("Env?", { options: ["local", "staging", "production"] });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("respects the default option's starting position", async () => {
    const fake = Tui.fake([Key.ENTER]);
    const result = await Tui.select("Env?", {
      options: ["local", "staging", "production"],
      default: "staging",
    });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("supports keyed options, returning the key as the value", async () => {
    const fake = Tui.fake([Key.DOWN, Key.ENTER]);
    const result = await Tui.select("Env?", { options: { local: "Local", staging: "Staging" } });
    expect(result).toBe("staging");
    fake.restore();
  });

  it("shows the option labels (not just keys) in the rendered output for keyed options", async () => {
    const fake = Tui.fake([Key.ENTER]);
    await Tui.select("Env?", { options: { local: "Local Environment" } });
    expect(fake.strippedOutput()).toContain("Local Environment");
    fake.restore();
  });

  it("scrolls when there are more options than the scroll window", async () => {
    const fake = Tui.fake([Key.DOWN, Key.DOWN, Key.DOWN, Key.DOWN, Key.DOWN, Key.ENTER]);
    const result = await Tui.select("Pick", {
      options: ["a", "b", "c", "d", "e", "f", "g"],
      scroll: 3,
    });
    expect(result).toBe("f");
    fake.restore();
  });

  it("shows the label in the rendered output", async () => {
    const fake = Tui.fake([Key.ENTER]);
    await Tui.select("Which environment?", { options: ["local"] });
    expect(fake.strippedOutput()).toContain("Which environment?");
    fake.restore();
  });
});
