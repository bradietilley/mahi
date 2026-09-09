import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tui } from "../src/tui.js";

describe("spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback and returns its result", async () => {
    const fake = Tui.fake([]);
    const result = await Tui.spinner("Fetching data...", () => 42);
    expect(result).toBe(42);
    fake.restore();
  });

  it("supports an async callback", async () => {
    const fake = Tui.fake([]);
    const promise = Tui.spinner("Fetching data...", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));

      return "done";
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe("done");
    fake.restore();
  });

  it("shows the message in the rendered output", async () => {
    const fake = Tui.fake([]);
    await Tui.spinner("Fetching data...", () => "ok");
    expect(fake.strippedOutput()).toContain("Fetching data...");
    fake.restore();
  });

  it("clears the animation timer after the callback resolves (no dangling setInterval)", async () => {
    const fake = Tui.fake([]);
    const promise = Tui.spinner("Working...", async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));

      return "ok";
    });
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
    fake.restore();
  });

  it("clears the animation timer even when the callback throws", async () => {
    const fake = Tui.fake([]);
    await expect(
      Tui.spinner("Working...", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
    fake.restore();
  });

  it("renders the static fallback frame once and starts no timer when non-interactive", async () => {
    vi.useRealTimers(); // avoid interplay between fake timers and Tui.interactive(false) path
    const fake = Tui.fake([]);
    Tui.interactive(false);
    const result = await Tui.spinner("Loading...", () => "value");
    expect(result).toBe("value");
    expect(fake.strippedOutput()).toContain("Loading...");
    fake.restore();
  });
});
