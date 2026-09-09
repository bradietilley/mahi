import { describe, expect, it } from "vitest";
import { Num } from "../src/number.js";

describe("Num", () => {
  it("format() uses Intl decimal grouping", () => {
    expect(Num.format(1000, { locale: "en-US" })).toBe("1,000");
    expect(Num.format(1.2345, { locale: "en-US", precision: 2 })).toBe("1.23");
  });

  it("currency() formats with a currency code", () => {
    expect(Num.currency(10, "USD", { locale: "en-US", precision: 2 })).toBe("$10.00");
  });

  it("percentage() treats the value as already in percent form", () => {
    expect(Num.percentage(10, { locale: "en-US" })).toBe("10%");
    expect(Num.percentage(10.5, { locale: "en-US", precision: 1 })).toBe("10.5%");
  });

  it("fileSize() picks a 1024-based unit", () => {
    expect(Num.fileSize(512)).toBe("512 B");
    expect(Num.fileSize(1024, 0)).toBe("1 KB");
    expect(Num.fileSize(1536, 1)).toBe("1.5 KB");
  });

  it("abbreviate() uses 1000-based suffixes", () => {
    expect(Num.abbreviate(999)).toBe("999");
    expect(Num.abbreviate(1500, 1)).toBe("1.5K");
    expect(Num.abbreviate(1_000_000)).toBe("1M");
    expect(Num.abbreviate(-1500, 1)).toBe("-1.5K");
  });

  it("clamp() bounds a value to [min, max]", () => {
    expect(Num.clamp(5, 0, 10)).toBe(5);
    expect(Num.clamp(-1, 0, 10)).toBe(0);
    expect(Num.clamp(11, 0, 10)).toBe(10);
  });
});
