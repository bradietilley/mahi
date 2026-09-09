import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { colorsEnabled, setColorOverride } from "../src/context.js";

/**
 * `colorsEnabled()` decides whether every `colors.*` wrapper emits ANSI. It
 * follows the cross-tool convention: `NO_COLOR` off, `FORCE_COLOR` on, else
 * TTY-only. Emitting escapes unconditionally would fill
 * `./artisan migrate:status | cat` with `^[[90m` garbage.
 */
describe("colorsEnabled()", () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalIsTty = process.stdout.isTTY;

  beforeEach(() => {
    // The suite-wide setup forces colour on; clear it so these tests see the
    // real env/TTY logic.
    setColorOverride(undefined);
  });

  afterEach(() => {
    setColorOverride(true);

    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }

    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }

    process.stdout.isTTY = originalIsTty;
  });

  it("honours an explicit override above everything", () => {
    setColorOverride(true);
    expect(colorsEnabled()).toBe(true);
    setColorOverride(false);
    expect(colorsEnabled()).toBe(false);
  });

  it("is disabled when NO_COLOR is set, regardless of TTY", () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    process.stdout.isTTY = true;
    expect(colorsEnabled()).toBe(false);
  });

  it("is enabled when FORCE_COLOR is set, even piped", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    process.stdout.isTTY = false as unknown as boolean;
    expect(colorsEnabled()).toBe(true);
  });

  it("FORCE_COLOR=0 does not force colour on", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "0";
    process.stdout.isTTY = false as unknown as boolean;
    expect(colorsEnabled()).toBe(false);
  });

  it("defaults to the TTY status when neither env var is set", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;

    process.stdout.isTTY = true;
    expect(colorsEnabled()).toBe(true);

    process.stdout.isTTY = false as unknown as boolean;
    expect(colorsEnabled()).toBe(false);
  });
});
