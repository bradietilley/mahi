import { describe, expect, it } from "vitest";
import { Str } from "../src/str.js";

describe("Str", () => {
  it("slug() normalizes accents, lowercases, and separates on non-alphanumerics", () => {
    expect(Str.slug("  Héllo, World!  ")).toBe("hello-world");
  });

  it("slug() supports a custom separator", () => {
    expect(Str.slug("Hello World", "_")).toBe("hello_world");
  });

  it("slug() supports regex-special separators without throwing or producing empty output", () => {
    expect(Str.slug("Hello World", "+")).toBe("hello+world");
    expect(Str.slug("Hello World", ".")).toBe("hello.world");
  });

  describe("inflection", () => {
    it("plural() handles regular, -es, -ies, -ves and irregular forms", () => {
      expect(Str.plural("car")).toBe("cars");
      expect(Str.plural("bus")).toBe("buses");
      expect(Str.plural("category")).toBe("categories");
      expect(Str.plural("knife")).toBe("knives");
      expect(Str.plural("child")).toBe("children");
      expect(Str.plural("Person")).toBe("People");
      expect(Str.plural("sheep")).toBe("sheep");
      expect(Str.plural("car", 1)).toBe("car");
    });

    it("singular() reverses the common forms", () => {
      expect(Str.singular("cars")).toBe("car");
      expect(Str.singular("buses")).toBe("bus");
      expect(Str.singular("categories")).toBe("category");
      expect(Str.singular("leaves")).toBe("leaf");
      expect(Str.singular("children")).toBe("child");
      expect(Str.singular("sheep")).toBe("sheep");
    });
  });

  describe("added helpers", () => {
    it("padLeft/padRight", () => {
      expect(Str.padLeft("5", 3, "0")).toBe("005");
      expect(Str.padRight("5", 3, "0")).toBe("500");
    });

    it("finish/start add only when absent", () => {
      expect(Str.finish("a/b", "/")).toBe("a/b/");
      expect(Str.finish("a/b/", "/")).toBe("a/b/");
      expect(Str.start("path", "/")).toBe("/path");
      expect(Str.start("/path", "/")).toBe("/path");
    });

    it("replaceFirst/replaceLast", () => {
      expect(Str.replaceFirst("a", "X", "a-a-a")).toBe("X-a-a");
      expect(Str.replaceLast("a", "X", "a-a-a")).toBe("a-a-X");
    });

    it("squish/wordCount", () => {
      expect(Str.squish("  a   b \n c ")).toBe("a b c");
      expect(Str.wordCount("one two three")).toBe(3);
    });

    it("headline", () => {
      expect(Str.headline("steve_jobs")).toBe("Steve Jobs");
      expect(Str.headline("EmailNotificationSent")).toBe("Email Notification Sent");
    });

    it("mask", () => {
      expect(Str.mask("taylor@example.com", "*", 3)).toBe("tay***************");
      expect(Str.mask("1234", "*", -2)).toBe("12**");
    });

    it("is() matches wildcard patterns", () => {
      expect(Str.is("foo*", "foobar")).toBe(true);
      expect(Str.is("baz*", "foobar")).toBe(false);
      expect(Str.is(["a*", "b*"], "bee")).toBe(true);
    });
  });

  it("limit() leaves strings shorter than length untouched", () => {
    expect(Str.limit("hi", 10)).toBe("hi");
  });

  it("limit() cuts and appends a suffix for strings longer than length", () => {
    expect(Str.limit("hello world", 5)).toBe("hello...");
  });

  it("limit() supports a custom suffix", () => {
    expect(Str.limit("hello world", 5, "…")).toBe("hello…");
  });

  it("camel()/snake()/kebab()/studly() round-trip through each other", () => {
    expect(Str.camel("foo-bar")).toBe("fooBar");
    expect(Str.camel("foo_bar_baz")).toBe("fooBarBaz");
    expect(Str.camel("FooBar")).toBe("fooBar");

    expect(Str.snake("fooBar")).toBe("foo_bar");
    expect(Str.snake("foo-bar")).toBe("foo_bar");

    expect(Str.kebab("fooBar")).toBe("foo-bar");
    expect(Str.kebab("foo_bar")).toBe("foo-bar");

    expect(Str.studly("foo-bar")).toBe("FooBar");
    expect(Str.studly("foo_bar")).toBe("FooBar");
  });

  it("random() generates strings of the requested length using distinct output", () => {
    const a = Str.random(16);
    const b = Str.random(16);

    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it("random() supports a custom length", () => {
    expect(Str.random(8)).toHaveLength(8);
  });

  describe("predicates", () => {
    it("contains()/startsWith()/endsWith() accept a string or an array of needles", () => {
      expect(Str.contains("hello world", "world")).toBe(true);
      expect(Str.contains("hello world", ["foo", "hello"])).toBe(true);
      expect(Str.contains("hello world", "xyz")).toBe(false);
      expect(Str.contains("hello", "")).toBe(false);
      expect(Str.startsWith("hello", "he")).toBe(true);
      expect(Str.startsWith("hello", ["x", "he"])).toBe(true);
      expect(Str.endsWith("hello", "lo")).toBe(true);
    });

    it("isUuid()/isUlid()/isJson() validate well-formed values", () => {
      expect(Str.isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(Str.isUuid("not-a-uuid")).toBe(false);
      expect(Str.isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
      expect(Str.isUlid("not-a-ulid")).toBe(false);
      expect(Str.isJson('{"a":1}')).toBe(true);
      expect(Str.isJson("not json")).toBe(false);
      expect(Str.isJson("")).toBe(false);
    });
  });

  describe("extraction", () => {
    it("after()/afterLast()/before()/beforeLast()/between()/substr()", () => {
      expect(Str.after("app/http/controllers/foo.ts", "/")).toBe("http/controllers/foo.ts");
      expect(Str.afterLast("app/http/controllers/foo.ts", "/")).toBe("foo.ts");
      expect(Str.before("app/http/controllers/foo.ts", "/")).toBe("app");
      expect(Str.beforeLast("app/http/controllers/foo.ts", "/")).toBe("app/http/controllers");
      expect(Str.between("abc", "x", "y")).toBe("abc");
      expect(Str.between("[a] [b]", "[", "]")).toBe("a] [b");
      expect(Str.substr("hello", 1, 3)).toBe("ell");
      expect(Str.substr("hello", -2)).toBe("lo");
    });
  });

  describe("case / format / ids", () => {
    it("lower()/upper()/title()/ucfirst()/words()", () => {
      expect(Str.lower("Foo")).toBe("foo");
      expect(Str.upper("Foo")).toBe("FOO");
      expect(Str.title("hello world")).toBe("Hello World");
      expect(Str.ucfirst("foo Bar")).toBe("Foo Bar");
      expect(Str.words("one two three four", 2)).toBe("one two...");
      expect(Str.words("one two", 5)).toBe("one two");
    });

    it("uuid() / ulid() generate valid identifiers", () => {
      const uuid = Str.uuid();
      const ulid = Str.ulid();
      expect(Str.isUuid(uuid)).toBe(true);
      expect(Str.isUlid(ulid)).toBe(true);
      expect(Str.ulid()).not.toBe(ulid);
    });

    it("uuid7() sets the version and variant fields per RFC 9562", () => {
      const id = Str.uuid7();

      expect(Str.isUuid(id)).toBe(true);
      // Version nibble is the 13th hex digit, variant the 17th.
      expect(id[14]).toBe("7");
      expect("89ab").toContain(id[19]);
    });

    it("uuid7() encodes the current time in its first 48 bits", () => {
      const before = Date.now();
      const id = Str.uuid7();
      const after = Date.now();

      const timestamp = parseInt(id.replace(/-/g, "").slice(0, 12), 16);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("uuid7() sorts lexicographically in creation order", async () => {
      // The entire reason to prefer it over uuid(): a v4 primary key
      // scatters inserts across the index at random, a v7 appends.
      const ids: string[] = [];

      for (let i = 0; i < 5; i++) {
        ids.push(Str.uuid7());
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      expect([...ids].sort()).toEqual(ids);
    });

    it("uuid7() stays unique within a single millisecond", () => {
      // Ordering comes from the timestamp, uniqueness from the 74 random
      // bits, so ids minted in the same tick are unordered but must not
      // collide.
      const ids = new Set(Array.from({ length: 10_000 }, () => Str.uuid7()));

      expect(ids.size).toBe(10_000);
    });

    it("orderedUuid() is a time-ordered uuid", () => {
      const id = Str.orderedUuid();

      expect(Str.isUuid(id)).toBe(true);
      expect(id[14]).toBe("7");
    });

    it("uuid() remains random, not ordered", () => {
      // Guards the distinction: if uuid() were ever pointed at uuid7(),
      // callers relying on unguessability would silently start leaking a
      // creation timestamp.
      const ids = Array.from({ length: 16 }, () => Str.uuid());

      expect([...ids].sort()).not.toEqual(ids);
      expect(ids[0]![14]).toBe("4");
    });

    it("escapeHtml() escapes the five HTML-significant characters", () => {
      expect(Str.escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
        "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
      );
      // `&` is escaped first, so entities are not double-escaped.
      expect(Str.escapeHtml("&amp;")).toBe("&amp;amp;");
      expect(Str.escapeHtml("plain")).toBe("plain");
    });
  });
});
