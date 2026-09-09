import { afterEach, describe, expect, it } from "vitest";
import { Tui } from "../src/tui.js";
import { Key } from "../src/terminal/key.js";

describe("ask", () => {
  afterEach(() => {
    // Ensure every test restores real stdin/stdout wiring even on failure.
    Tui.fake([]).restore();
  });

  it("returns the typed value when Enter is pressed", async () => {
    const fake = Tui.fake(["J", "a", "n", "e", Key.ENTER]);
    const result = await Tui.ask("Name?");
    expect(result).toBe("Jane");
    expect(fake.strippedOutput()).toContain("Name?");
    fake.restore();
  });

  it("supports backspace while typing", async () => {
    const fake = Tui.fake(["J", "a", "m", Key.BACKSPACE, "n", "e", Key.ENTER]);
    const result = await Tui.ask("Name?");
    expect(result).toBe("Jane");
    fake.restore();
  });

  it("returns the default value when Enter is pressed immediately", async () => {
    const fake = Tui.fake([Key.ENTER]);
    const result = await Tui.ask("Name?", { default: "World" });
    expect(result).toBe("World");
    fake.restore();
  });

  it("applies a transform function to the submitted value", async () => {
    const fake = Tui.fake(["h", "i", Key.ENTER]);
    const result = await Tui.ask("Say something", { transform: (v) => v.toUpperCase() });
    expect(result).toBe("HI");
    fake.restore();
  });

  it("blocks submission and shows a required error when required and empty", async () => {
    const fake = Tui.fake([Key.ENTER, "o", "k", Key.ENTER]);
    const result = await Tui.ask("Name?", { required: true });
    expect(result).toBe("ok");
    expect(fake.strippedOutput()).toContain("Required.");
    fake.restore();
  });

  it("shows a custom required error message", async () => {
    const fake = Tui.fake([Key.ENTER, "x", Key.ENTER]);
    await Tui.ask("Name?", { required: "Name is mandatory." });
    expect(fake.strippedOutput()).toContain("Name is mandatory.");
    fake.restore();
  });

  it("runs a custom validator and blocks submission until it passes", async () => {
    const fake = Tui.fake(["a", "b", Key.ENTER, "c", Key.ENTER]);
    const result = await Tui.ask("Value?", {
      validate: (v) => (v.length < 3 ? "Too short." : undefined),
    });
    expect(result).toBe("abc");
    expect(fake.strippedOutput()).toContain("Too short.");
    fake.restore();
  });

  it("supports an async validator without blocking the key-read loop", async () => {
    const fake = Tui.fake(["o", "k", Key.ENTER]);
    const result = await Tui.ask("Value?", {
      validate: async (v) => {
        await new Promise((resolve) => setTimeout(resolve, 1));

        return v === "ok" ? undefined : "Invalid.";
      },
    });
    expect(result).toBe("ok");
    fake.restore();
  });

  it("shows the label in the rendered output", async () => {
    const fake = Tui.fake(["x", Key.ENTER]);
    await Tui.ask("What's your name?");
    expect(fake.strippedOutput()).toContain("What's your name?");
    fake.restore();
  });
});
