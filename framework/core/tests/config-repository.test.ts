import { describe, expect, it } from "vitest";
import { ConfigRepository } from "../src/config-repository.js";

describe("ConfigRepository", () => {
  it("set() writes a nested value by dot notation, not a literal top-level key", () => {
    const config = new ConfigRepository();
    config.set("app.debug", true);

    expect(config.get("app.debug")).toBe(true);
    expect(config.get("app")).toEqual({ debug: true });
    expect(config.has("app.debug")).toBe(true);
  });

  it("set() creates intermediate objects along the path", () => {
    const config = new ConfigRepository();
    config.set("a.b.c", 1);
    expect(config.get("a.b.c")).toBe(1);
  });

  it("set() with a single segment replaces the whole namespace", () => {
    const config = new ConfigRepository();
    config.set("app", { debug: false, name: "x" });
    config.set("app", { debug: true });
    expect(config.get("app")).toEqual({ debug: true });
  });

  it("has() reflects presence, even for null values, and false when missing", () => {
    const config = new ConfigRepository();
    config.set("a.b", null);
    expect(config.has("a.b")).toBe(true);
    expect(config.has("a.c")).toBe(false);
  });

  it("all() returns an immutable clone — mutating it doesn't affect the repository", () => {
    const config = new ConfigRepository();
    config.set("app.name", "mahi");

    const snapshot = config.all();
    (snapshot.app as Record<string, unknown>).name = "hacked";

    expect(config.get("app.name")).toBe("mahi");
  });

  it("get() returns a clone of object values — mutation doesn't leak back", () => {
    const config = new ConfigRepository();
    config.set("app", { list: [1, 2] });

    const got = config.require<{ list: number[] }>("app");
    got.list.push(3);

    expect(config.require<{ list: number[] }>("app").list).toEqual([1, 2]);
  });

  it("merge() with a non-plain object leaf (Date) does not explode into empty objects", () => {
    const config = new ConfigRepository();
    const when = new Date("2020-01-01T00:00:00Z");
    config.merge("x", { when });
    config.merge("x", { when });
    expect(config.get("x.when")).toBeInstanceOf(Date);
  });

  it("push()/prepend() build and extend arrays", () => {
    const config = new ConfigRepository();
    config.push("a.list", 2);
    config.push("a.list", 3);
    config.prepend("a.list", 1);
    expect(config.get("a.list")).toEqual([1, 2, 3]);
  });

  it("ignores __proto__/constructor path segments (no prototype pollution)", () => {
    const config = new ConfigRepository();
    config.set("__proto__.polluted", true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
