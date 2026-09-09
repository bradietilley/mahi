import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/ansi/strip.js";
import { renderNote, writeNote } from "../src/note.js";
import { BufferedOutput } from "../src/output/buffered-output.js";

describe("note renderNote", () => {
  it("renders a plain note with a single leading space and no color", () => {
    expect(stripAnsi(renderNote("Deployed to production.", "note"))).toBe(
      " Deployed to production.",
    );
  });

  it("renders an error note in red", () => {
    const rendered = renderNote("Something went wrong.", "error");
    expect(rendered).toContain("\x1b[31m");
    expect(stripAnsi(rendered)).toBe(" Something went wrong.");
  });

  it("renders a warning note in yellow", () => {
    const rendered = renderNote("This will overwrite existing data.", "warning");
    expect(rendered).toContain("\x1b[33m");
    expect(stripAnsi(rendered)).toBe(" This will overwrite existing data.");
  });

  it("renders an info note in green", () => {
    const rendered = renderNote("Using cached results.", "info");
    expect(rendered).toContain("\x1b[32m");
    expect(stripAnsi(rendered)).toBe(" Using cached results.");
  });

  it("renders a success note as a green background block", () => {
    const rendered = renderNote("All checks passed.", "success");
    expect(rendered).toContain("\x1b[42m"); // bgGreen
    expect(stripAnsi(rendered)).toBe("  All checks passed. ");
  });

  it("renders an intro note as a cyan background block", () => {
    const rendered = renderNote("Deploying...", "intro");
    expect(rendered).toContain("\x1b[46m"); // bgCyan
    expect(stripAnsi(rendered)).toBe("  Deploying... ");
  });

  it("renders an outro note the same way as intro", () => {
    const rendered = renderNote("Done.", "outro");
    expect(rendered).toContain("\x1b[46m");
  });

  it("pads block-style notes (intro/success) so every line matches the widest line", () => {
    const rendered = renderNote("short\na much longer line", "success");
    const lines = stripAnsi(rendered).split("\n");
    expect(lines[0]!.length).toBe(lines[1]!.length);
  });

  it("preserves multiple lines in the message", () => {
    const rendered = renderNote("line one\nline two", "note");
    expect(stripAnsi(rendered)).toBe(" line one\n line two");
  });
});

describe("note writeNote", () => {
  it("writes exactly 2 blank lines before the note when nothing was written before", () => {
    const output = new BufferedOutput();
    writeNote(output, "hello", "note");
    expect(output.output()).toBe("\n\n hello\n");
  });

  it("writes fewer blank lines when the previous output already ended in newlines", () => {
    const output = new BufferedOutput();
    output.write("previous\n\n");
    writeNote(output, "hello", "note");
    expect(output.output()).toBe("previous\n\n hello\n");
  });

  it("writes no extra blank lines when 2+ trailing newlines already exist", () => {
    const output = new BufferedOutput();
    output.write("previous\n\n\n");
    writeNote(output, "hello", "note");
    expect(output.output()).toBe("previous\n\n\n hello\n");
  });
});
