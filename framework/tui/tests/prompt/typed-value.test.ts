import { describe, expect, it } from "vitest";
import { Key } from "../../src/terminal/key.js";
import { TypedValue, addCursor } from "../../src/prompt/typed-value.js";

describe("prompt/typed-value TypedValue", () => {
  it("starts with the given default value and cursor at the end", () => {
    const tv = new TypedValue("hi");
    expect(tv.value).toBe("hi");
    expect(tv.cursorPosition).toBe(2);
  });

  it("inserts printable characters at the cursor position", () => {
    const tv = new TypedValue();
    tv.handleKey("a");
    tv.handleKey("b");
    tv.handleKey("c");
    expect(tv.value).toBe("abc");
    expect(tv.cursorPosition).toBe(3);
  });

  it("backspaces the character before the cursor", () => {
    const tv = new TypedValue("abc");
    tv.handleKey(Key.BACKSPACE);
    expect(tv.value).toBe("ab");
    expect(tv.cursorPosition).toBe(2);
  });

  it("does nothing on backspace at position 0", () => {
    const tv = new TypedValue("");
    tv.handleKey(Key.BACKSPACE);
    expect(tv.value).toBe("");
    expect(tv.cursorPosition).toBe(0);
  });

  it("moves the cursor left and right with arrow keys", () => {
    const tv = new TypedValue("abc");
    tv.handleKey(Key.LEFT);
    expect(tv.cursorPosition).toBe(2);
    tv.handleKey(Key.RIGHT);
    expect(tv.cursorPosition).toBe(3);
  });

  it("clamps cursor movement at the start and end of the value", () => {
    const tv = new TypedValue("ab");
    tv.handleKey(Key.LEFT);
    tv.handleKey(Key.LEFT);
    tv.handleKey(Key.LEFT);
    expect(tv.cursorPosition).toBe(0);
    tv.handleKey(Key.RIGHT);
    tv.handleKey(Key.RIGHT);
    tv.handleKey(Key.RIGHT);
    expect(tv.cursorPosition).toBe(2);
  });

  it("jumps to start/end with Home/End", () => {
    const tv = new TypedValue("hello");
    tv.handleKey(Key.HOME);
    expect(tv.cursorPosition).toBe(0);
    tv.handleKey(Key.END);
    expect(tv.cursorPosition).toBe(5);
  });

  it("deletes the character at the cursor with Delete", () => {
    const tv = new TypedValue("abc");
    tv.handleKey(Key.HOME);
    tv.handleKey(Key.DELETE);
    expect(tv.value).toBe("bc");
    expect(tv.cursorPosition).toBe(0);
  });

  it("inserts at the cursor position, not just at the end", () => {
    const tv = new TypedValue("ac");
    tv.handleKey(Key.LEFT);
    tv.handleKey("b");
    expect(tv.value).toBe("abc");
    expect(tv.cursorPosition).toBe(2);
  });

  it("returns submit: true on Enter", () => {
    const tv = new TypedValue("done");
    const result = tv.handleKey(Key.ENTER);
    expect(result.submit).toBe(true);
    expect(tv.value).toBe("done"); // Enter does not mutate value
  });

  it("deletes the previous word with Option+Backspace", () => {
    const tv = new TypedValue("hello world");
    tv.handleKey(Key.OPTION_BACKSPACE);
    expect(tv.value).toBe("hello ");
  });

  it("stops word-delete at punctuation boundaries", () => {
    const tv = new TypedValue("word.word");
    tv.handleKey(Key.OPTION_BACKSPACE);
    expect(tv.value).toBe("word.");
  });

  it("keeps astral-plane characters (emoji) intact when typed", () => {
    const tv = new TypedValue();
    tv.handleKey("😀");
    expect(tv.value).toBe("😀");
    expect(tv.cursorPosition).toBe(1);
  });
});

describe("prompt/typed-value addCursor", () => {
  it("renders an inverse-video block at the cursor position", () => {
    const rendered = addCursor("abc", 1);
    expect(rendered).toContain("\x1b[7m");
  });

  it("renders a space as the cursor when the cursor is past the end of the value", () => {
    const rendered = addCursor("", 0);
    expect(rendered).toContain(`\x1b[7m \x1b[27m`);
  });

  it("truncates with an ellipsis when the value is wider than maxWidth", () => {
    const rendered = addCursor("a very long value that overflows", 33, 10);
    expect(rendered).toContain("…");
  });
});
