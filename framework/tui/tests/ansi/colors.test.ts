import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bgCyan,
  black,
  bold,
  cyan,
  dim,
  gray,
  green,
  inverse,
  red,
  strikethrough,
  yellow,
} from "../../src/ansi/colors.js";
import { setColorOverride } from "../../src/context.js";

describe("ansi/colors", () => {
  // Colour is gated on a TTY / NO_COLOR / FORCE_COLOR by default; tests run
  // under a non-TTY, so force it on to assert the SGR wrapping itself.
  beforeEach(() => setColorOverride(true));
  afterEach(() => setColorOverride(undefined));

  it("wraps text in bold SGR codes", () => {
    expect(bold("hi")).toBe("\x1b[1mhi\x1b[22m");
  });

  it("wraps text in dim SGR codes", () => {
    expect(dim("hi")).toBe("\x1b[2mhi\x1b[22m");
  });

  it("wraps text in red foreground SGR codes", () => {
    expect(red("hi")).toBe("\x1b[31mhi\x1b[39m");
  });

  it("wraps text in green foreground SGR codes", () => {
    expect(green("hi")).toBe("\x1b[32mhi\x1b[39m");
  });

  it("wraps text in yellow foreground SGR codes", () => {
    expect(yellow("hi")).toBe("\x1b[33mhi\x1b[39m");
  });

  it("wraps text in cyan foreground SGR codes", () => {
    expect(cyan("hi")).toBe("\x1b[36mhi\x1b[39m");
  });

  it("wraps text in gray (bright black) foreground SGR codes", () => {
    expect(gray("hi")).toBe("\x1b[90mhi\x1b[39m");
  });

  it("wraps text in black foreground SGR codes", () => {
    expect(black("hi")).toBe("\x1b[30mhi\x1b[39m");
  });

  it("wraps text in inverse-video SGR codes", () => {
    expect(inverse("hi")).toBe("\x1b[7mhi\x1b[27m");
  });

  it("wraps text in strikethrough SGR codes", () => {
    expect(strikethrough("hi")).toBe("\x1b[9mhi\x1b[29m");
  });

  it("wraps text in cyan background SGR codes", () => {
    expect(bgCyan("hi")).toBe("\x1b[46mhi\x1b[49m");
  });

  it("supports nesting/composition since each wrapper resets only its own attribute", () => {
    expect(bold(red("hi"))).toBe("\x1b[1m\x1b[31mhi\x1b[39m\x1b[22m");
  });

  it("emits no ANSI when colour is disabled (piped / NO_COLOR / non-TTY)", () => {
    setColorOverride(false);
    expect(red("hi")).toBe("hi");
    expect(bold("hi")).toBe("hi");
    expect(gray("hi")).toBe("hi");
    expect(bgCyan("hi")).toBe("hi");
  });
});
