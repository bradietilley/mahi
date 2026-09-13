import { describe, expect, it } from "vitest";
import { BindingNotFoundError, CircularDependencyError, Container } from "../src/container.js";

describe("Container", () => {
  it("bind() produces a new instance on every make() call", () => {
    const container = new Container();
    let calls = 0;
    container.bind("thing", () => ({ id: ++calls }));

    const a = container.make<{ id: number }>("thing");
    const b = container.make<{ id: number }>("thing");

    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a).not.toBe(b);
  });

  it("singleton() resolves once and caches the result", () => {
    const container = new Container();
    let calls = 0;
    container.singleton("thing", () => ({ id: ++calls }));

    const a = container.make<{ id: number }>("thing");
    const b = container.make<{ id: number }>("thing");

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("instance() registers an already-constructed value", () => {
    const container = new Container();
    const value = { hello: "world" };
    container.instance("thing", value);

    expect(container.make("thing")).toBe(value);
  });

  it("make() throws BindingNotFoundError for an unregistered token", () => {
    const container = new Container();
    expect(() => container.make("missing")).toThrow(BindingNotFoundError);
  });

  it("has() reflects both bind()/singleton() and instance() registrations", () => {
    const container = new Container();
    expect(container.has("a")).toBe(false);

    container.bind("a", () => 1);
    container.instance("b", 2);

    expect(container.has("a")).toBe(true);
    expect(container.has("b")).toBe(true);
  });

  it("factories receive the container itself, so they can resolve their own dependencies", () => {
    const container = new Container();
    container.instance("config", { greeting: "hi" });
    container.bind("greeter", (c) => {
      const config = c.make<{ greeting: string }>("config");

      return `${config.greeting}!`;
    });

    expect(container.make("greeter")).toBe("hi!");
  });

  it("extend() decorates a resolved value, including an already-cached singleton", () => {
    const container = new Container();
    container.singleton("n", () => 1);
    container.extend<number>("n", (n) => n + 1);
    expect(container.make<number>("n")).toBe(2);

    container.instance("m", 10);
    container.extend<number>("m", (m) => m * 2);
    expect(container.make<number>("m")).toBe(20);
  });

  it("extend() applies on every make() of a transient binding", () => {
    const container = new Container();
    let calls = 0;
    container.bind("n", () => ++calls);
    container.extend<number>("n", (n) => n * 10);
    expect(container.make<number>("n")).toBe(10);
    expect(container.make<number>("n")).toBe(20);
  });

  /**
   * The distinction shutdown depends on: `has()` says something is bound,
   * `isResolved()` says it was actually built. A provider closing what it
   * opened must skip the second, or `make()`ing the token to close it
   * constructs the very pool it is trying not to leave open.
   */
  describe("isResolved()", () => {
    it("is false for a bound-but-never-resolved singleton, true once made", () => {
      const container = new Container();
      container.singleton("db", () => ({ pool: true }));

      expect(container.has("db")).toBe(true);
      expect(container.isResolved("db")).toBe(false);

      container.make("db");

      expect(container.isResolved("db")).toBe(true);
    });

    it("is true immediately for instance(), which is already built", () => {
      const container = new Container();
      container.instance("db", { pool: true });

      expect(container.isResolved("db")).toBe(true);
    });

    it("stays false for a transient binding, which caches nothing", () => {
      const container = new Container();
      container.bind("db", () => ({ pool: true }));
      container.make("db");

      expect(container.isResolved("db")).toBe(false);
    });

    it("is false for an unbound token", () => {
      expect(new Container().isResolved("nope")).toBe(false);
    });
  });

  describe("circular dependencies", () => {
    it("throws a CircularDependencyError naming the cycle instead of a raw RangeError", () => {
      const container = new Container();
      container.singleton("a", (c) => c.make("b"));
      container.singleton("b", (c) => c.make("a"));

      let caught: unknown;
      try {
        container.make("a");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CircularDependencyError);
      expect((caught as CircularDependencyError).cycle).toEqual(["a", "b", "a"]);
    });

    it("recovers cleanly, a later independent resolution still works", () => {
      const container = new Container();
      container.singleton("a", (c) => c.make("b"));
      container.singleton("b", (c) => c.make("a"));
      container.bind("ok", () => 42);

      expect(() => container.make("a")).toThrow(CircularDependencyError);
      expect(container.make("ok")).toBe(42);
    });
  });

  describe("scoped()", () => {
    it("resolves once per scope and caches within it", () => {
      const container = new Container();
      let calls = 0;
      container.scoped("req", () => ({ id: ++calls }));

      container.runScoped(() => {
        const a = container.make<{ id: number }>("req");
        const b = container.make<{ id: number }>("req");
        expect(a).toBe(b);
        expect(calls).toBe(1);
      });
    });

    it("isolates instances between separate scopes", () => {
      const container = new Container();
      let calls = 0;
      container.scoped("req", () => ({ id: ++calls }));

      const first = container.runScoped(() => container.make<{ id: number }>("req"));
      const second = container.runScoped(() => container.make<{ id: number }>("req"));

      expect(first).not.toBe(second);
      expect(calls).toBe(2);
    });

    it("behaves transiently (never caches globally) outside any scope", () => {
      const container = new Container();
      let calls = 0;
      container.scoped("req", () => ({ id: ++calls }));

      container.make("req");
      container.make("req");
      expect(calls).toBe(2);
      expect(container.isResolved("req")).toBe(false);
    });

    it("survives across await boundaries within a scope", async () => {
      const container = new Container();
      let calls = 0;
      container.scoped("req", () => ({ id: ++calls }));

      await container.runScoped(async () => {
        const a = container.make("req");
        await Promise.resolve();
        const b = container.make("req");
        expect(a).toBe(b);
      });
    });
  });

  describe("forget()/forgetInstance()/flush()", () => {
    it("forget() removes the binding, cached instance and extenders", () => {
      const container = new Container();
      container.singleton("n", () => 1);
      container.extend<number>("n", (n) => n + 1);
      container.make("n");

      container.forget("n");
      expect(container.has("n")).toBe(false);
      expect(container.isResolved("n")).toBe(false);
    });

    it("forgetInstance() keeps the binding but rebuilds on next make()", () => {
      const container = new Container();
      let calls = 0;
      container.singleton("n", () => ++calls);
      expect(container.make("n")).toBe(1);

      container.forgetInstance("n");
      expect(container.make("n")).toBe(2);
    });

    it("flush() clears every binding", () => {
      const container = new Container();
      container.bind("a", () => 1);
      container.singleton("b", () => 2);
      container.make("b");

      container.flush();
      expect(container.has("a")).toBe(false);
      expect(container.has("b")).toBe(false);
    });
  });

  describe("rebinding", () => {
    it("re-binding a token clears extenders left from the previous binding", () => {
      const container = new Container();
      container.singleton("n", () => 1);
      container.extend<number>("n", (n) => n + 100);
      expect(container.make<number>("n")).toBe(101);

      // Re-bind: the old +100 extender must not still apply.
      container.singleton("n", () => 5);
      expect(container.make<number>("n")).toBe(5);
    });
  });
});
