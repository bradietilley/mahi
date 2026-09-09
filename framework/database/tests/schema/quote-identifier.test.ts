import { describe, expect, it } from "vitest";
import { quoteBacktick, quoteDoubleQuoted } from "../../src/schema/quote-identifier.js";

describe("quoteDoubleQuoted", () => {
  it("wraps a plain identifier in double quotes", () => {
    expect(quoteDoubleQuoted("users")).toBe('"users"');
  });

  it("doubles an embedded double quote so it can't break out", () => {
    expect(quoteDoubleQuoted('ev"il')).toBe('"ev""il"');
  });

  it("neutralises an injection attempt in a table name", () => {
    // A name that, unescaped, would close the identifier and append DDL.
    expect(quoteDoubleQuoted('t" cascade; drop table secrets --')).toBe(
      '"t"" cascade; drop table secrets --"',
    );
  });
});

describe("quoteBacktick", () => {
  it("wraps a plain identifier in backticks", () => {
    expect(quoteBacktick("users")).toBe("`users`");
  });

  it("doubles an embedded backtick so it can't break out", () => {
    expect(quoteBacktick("ev`il")).toBe("`ev``il`");
  });
});
