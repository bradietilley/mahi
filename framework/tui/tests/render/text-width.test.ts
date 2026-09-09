import { describe, expect, it } from "vitest";
import { red } from "../../src/ansi/colors.js";
import { displayWidth, pad, stripAnsi, truncate } from "../../src/render/text-width.js";

describe("render/text-width", () => {
  describe("stripAnsi", () => {
    it("removes SGR color codes", () => {
      expect(stripAnsi(red("hi"))).toBe("hi");
    });

    it("leaves plain text untouched", () => {
      expect(stripAnsi("hello")).toBe("hello");
    });
  });

  describe("displayWidth", () => {
    it("counts one column per plain ASCII character", () => {
      expect(displayWidth("hello")).toBe(5);
    });

    it("does not count ANSI escape codes as width", () => {
      expect(displayWidth(red("hi"))).toBe(2);
    });

    it("counts CJK characters as two columns wide", () => {
      expect(displayWidth("你好")).toBe(4);
    });

    it("counts a mix of ASCII and CJK correctly", () => {
      expect(displayWidth("a你b")).toBe(4);
    });

    it("counts common emoji as two columns wide", () => {
      expect(displayWidth("😀")).toBe(2);
    });

    it("does not count combining marks as extra width", () => {
      expect(displayWidth("e\u0301")).toBe(1); // é built from e + combining acute accent
    });

    it("returns 0 for an empty string", () => {
      expect(displayWidth("")).toBe(0);
    });
  });

  describe("truncate", () => {
    it("returns the original string unchanged when it already fits", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    it("truncates and appends an ellipsis when the string is too wide", () => {
      expect(truncate("hello world", 6)).toBe("hello…");
    });

    it("returns an empty string when width is 0 or less", () => {
      expect(truncate("hello", 0)).toBe("");
    });

    it("truncates wide characters without splitting one in half", () => {
      const result = truncate("你好世界", 5);
      expect(displayWidth(result)).toBeLessThanOrEqual(5);
      expect(result.endsWith("…")).toBe(true);
    });
  });

  describe("pad", () => {
    it("right-pads a short string with spaces to the target width", () => {
      expect(pad("hi", 5)).toBe("hi   ");
    });

    it("does not pad a string already at or beyond the target width", () => {
      expect(pad("hello world", 5)).toBe("hello world");
    });

    it("pads using display width, ignoring ANSI codes in the source text", () => {
      const colored = red("hi");
      expect(pad(colored, 5)).toBe(`${colored}   `);
    });

    it("supports a custom padding character", () => {
      expect(pad("hi", 5, ".")).toBe("hi...");
    });
  });
});
