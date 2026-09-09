import { describe, expect, it } from "vitest";
import { narrowKey, sameKey } from "../src/key-identity.js";

describe("narrowKey", () => {
  it("returns a safe bigint as a number", () => {
    expect(narrowKey(42n)).toBe(42);
  });

  it("returns an unsafe bigint as a decimal string rather than losing precision", () => {
    // Number(9007199254740993n) would be 9007199254740992 — a different row.
    expect(narrowKey(9007199254740993n)).toBe("9007199254740993");
  });

  it("returns safe numeric text as a number and unsafe text as-is", () => {
    expect(narrowKey("42")).toBe(42);
    expect(narrowKey("9007199254740993")).toBe("9007199254740993");
  });

  it("passes a number through", () => {
    expect(narrowKey(7)).toBe(7);
  });
});

describe("sameKey", () => {
  it("treats a number and its string spelling as the same row", () => {
    expect(sameKey(1, "1")).toBe(true);
    expect(sameKey("1", 1)).toBe(true);
  });

  it("distinguishes different keys", () => {
    expect(sameKey(1, 2)).toBe(false);
    expect(sameKey("a", "b")).toBe(false);
  });
});
