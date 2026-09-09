import { describe, expect, it } from "vitest";
import { Tui } from "../src/tui.js";
import { Key } from "../src/terminal/key.js";

describe("secret", () => {
  it("returns the typed value when Enter is pressed", async () => {
    const fake = Tui.fake(["h", "u", "n", "t", "e", "r", "2", Key.ENTER]);
    const result = await Tui.secret("Password?");
    expect(result).toBe("hunter2");
    fake.restore();
  });

  it("does not echo the typed value in the rendered output", async () => {
    const fake = Tui.fake(["s", "e", "c", "r", "e", "t", Key.ENTER]);
    await Tui.secret("Password?");
    expect(fake.strippedOutput()).not.toContain("secret");
    fake.restore();
  });

  it("masks the typed value with bullet characters", async () => {
    const fake = Tui.fake(["a", "b", "c", Key.ENTER]);
    await Tui.secret("Password?");
    expect(fake.strippedOutput()).toContain("•");
    fake.restore();
  });

  it("supports backspace while typing", async () => {
    const fake = Tui.fake(["a", "b", "x", Key.BACKSPACE, "c", Key.ENTER]);
    const result = await Tui.secret("Password?");
    expect(result).toBe("abc");
    fake.restore();
  });

  it("blocks submission and shows a required error when required and empty", async () => {
    const fake = Tui.fake([Key.ENTER, "o", "k", Key.ENTER]);
    const result = await Tui.secret("Password?", { required: true });
    expect(result).toBe("ok");
    expect(fake.strippedOutput()).toContain("Required.");
    fake.restore();
  });

  it("runs a custom validator and blocks submission until it passes", async () => {
    const fake = Tui.fake(["a", "b", Key.ENTER, "c", Key.ENTER]);
    const result = await Tui.secret("Password?", {
      validate: (v) => (v.length < 3 ? "Too short." : undefined),
    });
    expect(result).toBe("abc");
    expect(fake.strippedOutput()).toContain("Too short.");
    fake.restore();
  });

  it("applies a transform function to the submitted value", async () => {
    const fake = Tui.fake(["h", "i", Key.ENTER]);
    const result = await Tui.secret("Password?", { transform: (v) => v.toUpperCase() });
    expect(result).toBe("HI");
    fake.restore();
  });

  it("shows the label in the rendered output", async () => {
    const fake = Tui.fake(["x", Key.ENTER]);
    await Tui.secret("Enter your password");
    expect(fake.strippedOutput()).toContain("Enter your password");
    fake.restore();
  });
});
