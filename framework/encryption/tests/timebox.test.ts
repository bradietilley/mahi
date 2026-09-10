import { describe, expect, it } from "vitest";
import { timebox } from "../src/timebox.js";

describe("timebox", () => {
  it("returns fn's result", async () => {
    await expect(timebox(() => 42, 10)).resolves.toBe(42);
  });

  it("waits at least minMs for a fast fn", async () => {
    const start = Date.now();
    await timebox(() => "quick", 50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45); // small scheduler slack
  });

  it("does not add delay when fn already exceeds minMs", async () => {
    const start = Date.now();
    await timebox(async () => {
      await new Promise((r) => setTimeout(r, 60));
    }, 20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(120);
  });

  it("still enforces the floor when fn throws, and rethrows", async () => {
    const start = Date.now();
    await expect(
      timebox(() => {
        throw new Error("boom");
      }, 50),
    ).rejects.toThrow("boom");
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});
