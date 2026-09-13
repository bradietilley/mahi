import { describe, expect, it } from "vitest";
import { ContextRepository } from "../src/context.js";

describe("ContextRepository", () => {
  describe("add / get / has / missing", () => {
    it("adds a single key/value pair", () => {
      const context = new ContextRepository();
      context.add("deploy", "abc123");

      expect(context.get("deploy")).toBe("abc123");
      expect(context.has("deploy")).toBe(true);
      expect(context.missing("deploy")).toBe(false);
    });

    it("merges a record of values in one call", () => {
      const context = new ContextRepository();
      context.add({ a: 1, b: 2 });

      expect(context.all()).toEqual({ a: 1, b: 2 });
    });

    it("overwrites existing values", () => {
      const context = new ContextRepository();
      context.add("key", "old").add("key", "new");

      expect(context.get("key")).toBe("new");
    });

    it("get() returns the default for absent keys, and undefined without one", () => {
      const context = new ContextRepository();

      expect(context.get("nope")).toBeUndefined();
      expect(context.get("nope", "fallback")).toBe("fallback");
    });

    it("has() is true for keys explicitly set to null/undefined-ish values", () => {
      const context = new ContextRepository();
      context.add("nullable", null);

      expect(context.has("nullable")).toBe(true);
      expect(context.get("nullable", "default")).toBeNull();
    });
  });

  describe("addIf", () => {
    it("adds only when the key is absent", () => {
      const context = new ContextRepository();
      context.addIf("key", "first");
      context.addIf("key", "second");

      expect(context.get("key")).toBe("first");
    });
  });

  describe("pull", () => {
    it("returns the value and removes the key", () => {
      const context = new ContextRepository();
      context.add("once", "value");

      expect(context.pull("once")).toBe("value");
      expect(context.has("once")).toBe(false);
    });

    it("returns the default when the key is absent", () => {
      expect(new ContextRepository().pull("nope", "fallback")).toBe("fallback");
    });
  });

  describe("all / only / except", () => {
    it("all() returns a copy, mutating it does not affect the repository", () => {
      const context = new ContextRepository();
      context.add("a", 1);

      const all = context.all();
      all.b = 2;

      expect(context.all()).toEqual({ a: 1 });
    });

    it("only() returns just the requested keys, omitting absent ones", () => {
      const context = new ContextRepository();
      context.add({ a: 1, b: 2, c: 3 });

      expect(context.only(["a", "c", "missing"])).toEqual({ a: 1, c: 3 });
    });

    it("except() returns everything but the given keys", () => {
      const context = new ContextRepository();
      context.add({ a: 1, b: 2, c: 3 });

      expect(context.except(["b"])).toEqual({ a: 1, c: 3 });
    });
  });

  describe("forget / flush / isEmpty", () => {
    it("forget() removes a single key or an array of keys", () => {
      const context = new ContextRepository();
      context.add({ a: 1, b: 2, c: 3 });

      context.forget("a");
      expect(context.all()).toEqual({ b: 2, c: 3 });

      context.forget(["b", "c"]);
      expect(context.isEmpty()).toBe(true);
    });

    it("flush() removes everything", () => {
      const context = new ContextRepository();
      context.add({ a: 1, b: 2 });

      context.flush();

      expect(context.isEmpty()).toBe(true);
      expect(context.all()).toEqual({});
    });

    it("isEmpty() is true for a fresh repository", () => {
      expect(new ContextRepository().isEmpty()).toBe(true);
    });
  });

  describe("push", () => {
    it("creates the array on first push and appends on subsequent pushes", () => {
      const context = new ContextRepository();
      context.push("breadcrumbs", "one");
      context.push("breadcrumbs", "two", "three");

      expect(context.get("breadcrumbs")).toEqual(["one", "two", "three"]);
    });

    it("throws when the key already holds a non-array", () => {
      const context = new ContextRepository();
      context.add("scalar", "not an array");

      expect(() => context.push("scalar", "x")).toThrow(/not an array/);
    });
  });

  describe("remember", () => {
    it("computes and stores on first call, reuses on subsequent calls", () => {
      const context = new ContextRepository();
      let calls = 0;
      const factory = () => {
        calls += 1;

        return "computed";
      };

      expect(context.remember("key", factory)).toBe("computed");
      expect(context.remember("key", factory)).toBe("computed");
      expect(calls).toBe(1);
    });
  });

  describe("scope", () => {
    it("merges data for the duration of the callback and restores afterwards", () => {
      const context = new ContextRepository();
      context.add("outer", "stays");

      const result = context.scope(
        () => {
          expect(context.all()).toEqual({ outer: "stays", inner: "temporary" });

          return "returned";
        },
        { inner: "temporary" },
      );

      expect(result).toBe("returned");
      expect(context.all()).toEqual({ outer: "stays" });
    });

    it("discards changes the callback itself makes", () => {
      const context = new ContextRepository();
      context.add("outer", "original");

      context.scope(() => {
        context.add("outer", "mutated");
        context.add("added-inside", true);
      });

      expect(context.all()).toEqual({ outer: "original" });
    });

    it("restores the previous context when the callback throws", () => {
      const context = new ContextRepository();
      context.add("outer", "stays");

      expect(() =>
        context.scope(
          () => {
            throw new Error("boom");
          },
          { inner: "temporary" },
        ),
      ).toThrow("boom");

      expect(context.all()).toEqual({ outer: "stays" });
    });

    it("restores only after an async callback settles", async () => {
      const context = new ContextRepository();
      context.add("outer", "stays");

      const promise = context.scope(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(context.get("inner")).toBe("temporary");
        },
        { inner: "temporary" },
      );

      // Still scoped while the promise is pending (process-global caveat).
      expect(context.get("inner")).toBe("temporary");

      await promise;
      expect(context.all()).toEqual({ outer: "stays" });
    });

    it("restores when an async callback rejects", async () => {
      const context = new ContextRepository();

      await expect(
        context.scope(
          async () => {
            throw new Error("async boom");
          },
          { inner: "temporary" },
        ),
      ).rejects.toThrow("async boom");

      expect(context.isEmpty()).toBe(true);
    });
  });

  describe("runScoped: per-request isolation", () => {
    it("seeds the overlay with the current global context", () => {
      const context = new ContextRepository();
      context.add("deploy", "abc123");

      context.runScoped(() => {
        expect(context.get("deploy")).toBe("abc123");
      });
    });

    it("does not leak writes made inside a scope back to the global store", () => {
      const context = new ContextRepository();
      context.add("deploy", "abc123");

      context.runScoped(() => {
        context.add("requestId", "req-1");
        expect(context.get("requestId")).toBe("req-1");
      });

      // The request-scoped key is gone once the scope closes.
      expect(context.has("requestId")).toBe(false);
      // Global data is untouched.
      expect(context.get("deploy")).toBe("abc123");
    });

    it("does not leak forgets made inside a scope back to the global store", () => {
      const context = new ContextRepository();
      context.add("deploy", "abc123");

      context.runScoped(() => {
        context.forget("deploy");
        expect(context.has("deploy")).toBe(false);
      });

      expect(context.get("deploy")).toBe("abc123");
    });

    it("isolates two concurrent async scopes from each other", async () => {
      const context = new ContextRepository();
      const seen: Record<string, unknown> = {};

      const one = context.runScoped(async () => {
        context.add("id", "one");
        await new Promise((r) => setTimeout(r, 10));
        seen.one = context.get("id");
      });

      const two = context.runScoped(async () => {
        context.add("id", "two");
        await new Promise((r) => setTimeout(r, 5));
        seen.two = context.get("id");
      });

      await Promise.all([one, two]);

      expect(seen.one).toBe("one");
      expect(seen.two).toBe("two");
    });

    it("reports whether a scope is active", () => {
      const context = new ContextRepository();
      expect(context.hasScope()).toBe(false);
      context.runScoped(() => {
        expect(context.hasScope()).toBe(true);
      });
      expect(context.hasScope()).toBe(false);
    });

    it("scope() inside a request snapshots the overlay, not the global store", () => {
      const context = new ContextRepository();
      context.add("global", "g");

      context.runScoped(() => {
        context.add("req", "r");
        context.scope(
          () => {
            expect(context.get("temp")).toBe("t");
            expect(context.get("req")).toBe("r");
          },
          { temp: "t" },
        );
        // Temporary key is discarded, request key survives.
        expect(context.has("temp")).toBe(false);
        expect(context.get("req")).toBe("r");
      });

      expect(context.has("req")).toBe(false);
      expect(context.get("global")).toBe("g");
    });
  });
});
