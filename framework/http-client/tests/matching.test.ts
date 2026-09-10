import { describe, expect, it } from "vitest";
import { urlMatch, wildcardMatch } from "../src/matching.js";
import { resolveUrl } from "../src/url-template.js";

describe("wildcardMatch", () => {
  it("treats * as a wildcard", () => {
    expect(wildcardMatch("github.com/*", "github.com/repos")).toBe(true);
  });

  it("treats ? as a literal, not a regex quantifier (Laravel Str::is)", () => {
    // With `?` unescaped this would compile to /^a?b$/ and match "b".
    expect(wildcardMatch("a?b", "a?b")).toBe(true);
    expect(wildcardMatch("a?b", "b")).toBe(false);
    expect(wildcardMatch("a?b", "ab")).toBe(false);
  });

  it("urlMatch prepends an implicit leading *", () => {
    expect(urlMatch("github.com/*", "https://api.github.com/repos")).toBe(true);
  });
});

describe("resolveUrl", () => {
  it("prefixes a relative path with the base URL", () => {
    expect(resolveUrl("https://api.test/", "/users")).toBe("https://api.test/users");
  });

  it("leaves any absolute URL alone, not just http(s)", () => {
    expect(resolveUrl("https://api.test", "ws://sock.test/x")).toBe("ws://sock.test/x");
    expect(resolveUrl("https://api.test", "data:text/plain,hi")).toBe("data:text/plain,hi");
    expect(resolveUrl("https://api.test", "//cdn.test/a.js")).toBe("//cdn.test/a.js");
  });
});
