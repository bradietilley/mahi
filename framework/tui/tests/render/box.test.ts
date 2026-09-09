import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/ansi/strip.js";
import { drawBox } from "../../src/render/box.js";

describe("render/box drawBox", () => {
  it("draws a box with the title inlined into the top border", () => {
    const box = drawBox({ title: "Hi", body: "world" }, 80);
    const lines = stripAnsi(box).split("\n");
    expect(lines[0]).toContain("Hi");
    expect(lines[0]!.startsWith(" ┌")).toBe(true);
    expect(lines[0]!.endsWith("┐")).toBe(true);
  });

  it("draws a box with no title inset when the title is empty", () => {
    const box = drawBox({ title: "", body: "world" }, 80);
    const lines = stripAnsi(box).split("\n");
    // default minWidth of 60, plus 2 extra dashes when there's no title label.
    expect(lines[0]).toBe(` ┌${"─".repeat(62)}┐`);
  });

  it("pads the body to the box's computed width", () => {
    const box = drawBox({ title: "", body: "hi" }, 80);
    const lines = stripAnsi(box).split("\n");
    // default minWidth of 60
    expect(lines[1]).toBe(` │ ${"hi".padEnd(60)} │`);
  });

  it("widens the box to fit a body line longer than minWidth", () => {
    const longLine = "x".repeat(70);
    const box = drawBox({ title: "", body: longLine }, 100);
    const lines = stripAnsi(box).split("\n");
    expect(lines[1]).toBe(` │ ${longLine} │`);
  });

  it("clamps the minimum width to terminalCols - 6 on narrow terminals", () => {
    const box = drawBox({ title: "", body: "hi" }, 40);
    const lines = stripAnsi(box).split("\n");
    // effectiveMinWidth = min(60, 40 - 6) = 34, plus 2 extra dashes when there's no title label.
    expect(lines[0]).toBe(` ┌${"─".repeat(36)}┐`);
  });

  it("renders a footer section separated by a divider", () => {
    const box = drawBox({ title: "", body: "value", footer: "Cancelled." }, 80);
    const lines = stripAnsi(box).split("\n");
    expect(lines.some((l) => l.startsWith(" ├") && l.endsWith("┤"))).toBe(true);
    expect(lines.some((l) => l.includes("Cancelled."))).toBe(true);
  });

  it("omits the footer divider when footer is empty", () => {
    const box = drawBox({ title: "", body: "value" }, 80);
    const lines = stripAnsi(box).split("\n");
    expect(lines.some((l) => l.startsWith(" ├"))).toBe(false);
  });

  it("right-aligns info text into the bottom border", () => {
    const box = drawBox({ title: "", body: "value", info: "42 / 100" }, 80);
    const lines = stripAnsi(box).split("\n");
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine.endsWith("42 / 100 ┘")).toBe(true);
    expect(lastLine.startsWith(" └")).toBe(true);
  });

  it("draws a plain bottom border with no info text", () => {
    const box = drawBox({ title: "", body: "value" }, 80);
    const lines = stripAnsi(box).split("\n");
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toBe(` └${"─".repeat(62)}┘`);
  });

  it("supports multi-line body text", () => {
    const box = drawBox({ title: "", body: "line one\nline two" }, 80);
    const lines = stripAnsi(box).split("\n");
    expect(lines[1]).toContain("line one");
    expect(lines[2]).toContain("line two");
  });
});
