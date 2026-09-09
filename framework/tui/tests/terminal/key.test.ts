import { describe, expect, it } from "vitest";
import { Key, splitKeys } from "../../src/terminal/key.js";

describe("terminal/key splitKeys", () => {
  it("splits a single arrow key escape sequence into one token", () => {
    expect(splitKeys(Key.UP)).toEqual([Key.UP]);
  });

  it("splits a Ctrl+C byte into one token", () => {
    expect(splitKeys(Key.CTRL_C)).toEqual([Key.CTRL_C]);
  });

  it("splits a fast multi-key chunk (typing 'ab' in one data event) into separate characters", () => {
    expect(splitKeys("ab")).toEqual(["a", "b"]);
  });

  it("splits an escape sequence immediately followed by a printable character in the same chunk", () => {
    expect(splitKeys(Key.UP + "x")).toEqual([Key.UP, "x"]);
  });

  it("splits multiple escape sequences back to back", () => {
    expect(splitKeys(Key.UP + Key.DOWN)).toEqual([Key.UP, Key.DOWN]);
  });

  it("splits an SS3 application-mode arrow key sequence", () => {
    expect(splitKeys("\x1bOA")).toEqual(["\x1bOA"]);
  });

  it("splits Option+Backspace as a two-byte token", () => {
    expect(splitKeys("\x1b\x7f")).toEqual(["\x1b\x7f"]);
  });

  it("treats a bare trailing Escape byte as its own token", () => {
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
  });

  it("handles a Home key CSI sequence with a numeric parameter", () => {
    expect(splitKeys("\x1b[1~")).toEqual(["\x1b[1~"]);
  });

  it("does not hang on an unrecognized escape + character combo", () => {
    expect(splitKeys("\x1bq")).toEqual(["\x1bq"]);
  });

  it("keeps an astral-plane codepoint (emoji) as a single token instead of splitting surrogate halves", () => {
    const emoji = "😀";
    expect(splitKeys(emoji)).toEqual([emoji]);
  });

  it("splits a paste burst of plain text into individual character tokens", () => {
    expect(splitKeys("hello")).toEqual(["h", "e", "l", "l", "o"]);
  });
});
