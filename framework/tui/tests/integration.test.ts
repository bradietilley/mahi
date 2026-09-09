import { describe, expect, it, vi } from "vitest";
import { Tui } from "../src/tui.js";
import { Key } from "../src/terminal/key.js";

/**
 * Exercises all six features against a single `Tui.fake()`d session in
 * sequence, to catch spacing/interaction bugs between features that
 * per-feature unit tests wouldn't (e.g. does the "2 blank lines between
 * blocks" rule hold when a `note()` is followed immediately by an
 * `ask()`).
 */
describe("Tui integration", () => {
  it("runs note, ask, select, progress, spinner, and table in sequence with consistent spacing", async () => {
    const fake = Tui.fake([
      // ask("What's your name?") — clear the default via Backspace before typing
      Key.BACKSPACE,
      Key.BACKSPACE,
      Key.BACKSPACE,
      Key.BACKSPACE,
      Key.BACKSPACE,
      "J",
      "a",
      "n",
      "e",
      Key.ENTER,
      // select("Which environment?")
      Key.DOWN,
      Key.ENTER,
    ]);

    vi.useFakeTimers();

    Tui.note("Deployed to production.");
    Tui.error("Something went wrong.");
    Tui.warning("This will overwrite existing data.");
    Tui.info("Using cached results.");
    Tui.success("All checks passed.");

    const name = await Tui.ask("What's your name?", { default: "World" });
    const env = await Tui.select("Which environment?", {
      options: ["local", "staging", "production"],
    });

    const bar = Tui.progress("Processing", 3);
    bar.start();
    bar.advance();
    bar.advance();
    bar.advance();
    bar.finish();

    const spinnerPromise = Tui.spinner("Fetching data...", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      return "fetched";
    });
    await vi.advanceTimersByTimeAsync(10);
    const spinnerResult = await spinnerPromise;

    vi.useRealTimers();

    Tui.table(
      ["Name", "Email"],
      [
        ["Ada", "ada@example.com"],
        ["Grace", "grace@example.com"],
      ],
    );

    expect(name).toBe("Jane");
    expect(env).toBe("staging");
    expect(spinnerResult).toBe("fetched");

    const output = fake.strippedOutput();
    expect(output).toContain("Deployed to production.");
    expect(output).toContain("Something went wrong.");
    expect(output).toContain("This will overwrite existing data.");
    expect(output).toContain("Using cached results.");
    expect(output).toContain("All checks passed.");
    expect(output).toContain("What's your name?");
    expect(output).toContain("Which environment?");
    expect(output).toContain("Processing");
    expect(output).toContain("Fetching data...");
    expect(output).toContain("Ada");
    expect(output).toContain("Grace");

    // Blocks should never be jammed together with zero blank lines
    // between them — every finished-frame write starts with at least
    // some spacing logic applied (verified indirectly: no line should
    // have both a note's trailing content and the next block's box
    // glued on the same line).
    expect(output).not.toMatch(/checks passed\.\s*┌/);

    fake.restore();
  });

  it("keeps exactly 2 blank lines before the first note and 1 blank line between two consecutive notes (each note ends with exactly 1 trailing newline)", () => {
    const fake = Tui.fake([]);
    Tui.note("first");
    Tui.note("second");
    const output = fake.output();
    // First note gets the full "2 - newLinesWritten()" prefix (0 written
    // so far -> 2 blank lines). Each note's own single trailing newline
    // means the second note only needs 1 more blank line to reach the
    // "2 blank lines between blocks" total gap.
    expect(output).toBe("\n\n first\n\n second\n");
    fake.restore();
  });
});
