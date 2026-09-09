import { describe, expect, it } from "vitest";
import { Arr } from "../src/arr.js";
import { ItemNotFoundError, MultipleItemsFoundError } from "../src/collection.js";

describe("Arr", () => {
  describe("wrap()", () => {
    it("returns an empty array for null", () => {
      expect(Arr.wrap(null)).toEqual([]);
    });

    it("returns an empty array for undefined", () => {
      expect(Arr.wrap(undefined)).toEqual([]);
    });

    it("wraps a scalar in a single-element array", () => {
      expect(Arr.wrap("a")).toEqual(["a"]);
    });

    it("returns an array unchanged", () => {
      expect(Arr.wrap([1, 2, 3])).toEqual([1, 2, 3]);
    });
  });

  describe("flatten()", () => {
    it("flattens a mixed-depth-1 array", () => {
      expect(Arr.flatten([1, [2, 3], 4, [5]])).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("only()", () => {
    it("picks only the given keys", () => {
      expect(Arr.only({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
    });

    it("ignores keys that are missing from the object", () => {
      expect(Arr.only({ a: 1 }, ["a", "b" as "a"])).toEqual({ a: 1 });
    });
  });

  describe("except()", () => {
    it("omits the given keys", () => {
      expect(Arr.except({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
    });

    it("is a no-op when no keys are excluded", () => {
      expect(Arr.except({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
    });
  });

  describe("get() / set() / has() / forget() / pull()", () => {
    it("get() reads a dotted path with a fallback", () => {
      expect(Arr.get({ a: { b: 1 } }, "a.b")).toBe(1);
      const empty: { a: { b?: number } } = { a: {} };
      expect(Arr.get(empty, "a.b", 0)).toBe(0);
    });

    it("set() writes a dotted path", () => {
      const target: { a: { b: number; c?: number } } = { a: { b: 1 } };
      Arr.set(target, "a.c", 2);
      expect(target).toEqual({ a: { b: 1, c: 2 } });
    });

    it("has() / hasAny() check nested presence", () => {
      const target: { a: { b: number }; c: number; missing?: number } = { a: { b: 1 }, c: 2 };
      expect(Arr.has(target, "a.b")).toBe(true);
      expect(Arr.has(target, ["a.b", "c"])).toBe(true);
      expect(Arr.has(target, ["a.b", "missing"])).toBe(false);
      expect(Arr.hasAny(target, ["missing", "c"])).toBe(true);
    });

    it("pull() returns a value and removes it", () => {
      const target = { a: { b: 1, c: 2 } };
      expect(Arr.pull(target, "a.b")).toBe(1);
      expect(target).toEqual({ a: { c: 2 } });
    });
  });

  describe("first() / last() / sole()", () => {
    it("first()/last() support an optional predicate and fallback", () => {
      expect(Arr.first([1, 2, 3])).toBe(1);
      expect(Arr.last([1, 2, 3])).toBe(3);
      expect(Arr.first([1, 2, 3], (n) => n > 1)).toBe(2);
      expect(Arr.last([1, 2, 3], (n) => n < 3)).toBe(2);
      expect(Arr.first([], null, "missing")).toBe("missing");
      expect(Arr.first([], null, () => "lazy")).toBe("lazy");
    });

    it("sole() returns the only matching item or throws a dedicated error", () => {
      expect(Arr.sole([1])).toBe(1);
      expect(Arr.sole([1, 2, 3], (n) => n === 2)).toBe(2);
      expect(() => Arr.sole([])).toThrow(ItemNotFoundError);
      expect(() => Arr.sole([1, 2])).toThrow(MultipleItemsFoundError);
    });
  });

  describe("isList() / isAssoc() / dot() / undot()", () => {
    it("isList() is true for arrays and sequential-key objects", () => {
      expect(Arr.isList([1, 2])).toBe(true);
      expect(Arr.isList({})).toBe(true);
      expect(Arr.isList({ 0: "a", 1: "b" })).toBe(true);
      expect(Arr.isList({ a: 1 })).toBe(false);
      expect(Arr.isAssoc({ a: 1 })).toBe(true);
      expect(Arr.isAssoc([1])).toBe(false);
    });

    it("dot() flattens nested objects; undot() restores them", () => {
      const nested = { a: { b: 1 }, users: [{ name: "Ada" }] };
      const flat = Arr.dot(nested);
      expect(flat).toEqual({ "a.b": 1, "users.0.name": "Ada" });
      expect(Arr.undot(flat)).toEqual(nested);
    });

    it("dot() treats non-plain objects (Date) as leaves, not recursing into {}", () => {
      const when = new Date("2020-01-01T00:00:00Z");
      expect(Arr.dot({ when })).toEqual({ when });
    });
  });

  describe("divide() / crossJoin() / partition() / where() / query()", () => {
    it("divide() splits keys and values", () => {
      expect(Arr.divide({ a: 1, b: 2 })).toEqual([
        ["a", "b"],
        [1, 2],
      ]);
    });

    it("crossJoin() builds the cartesian product", () => {
      expect(Arr.crossJoin([1, 2], ["a", "b"])).toEqual([
        [1, "a"],
        [1, "b"],
        [2, "a"],
        [2, "b"],
      ]);
    });

    it("partition() / where() / whereNotNull() filter arrays", () => {
      expect(Arr.partition([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([
        [2, 4],
        [1, 3],
      ]);
      expect(Arr.where([1, 2, 3], (n) => n > 1)).toEqual([2, 3]);
      expect(Arr.whereNotNull([1, null, 2, undefined])).toEqual([1, 2]);
    });

    it("query() builds a nested query string", () => {
      const qs = Arr.query({ user: { name: "Ada" }, tags: ["a", "b"] });
      const params = new URLSearchParams(qs);
      expect(params.get("user[name]")).toBe("Ada");
      expect(params.get("tags[0]")).toBe("a");
      expect(params.get("tags[1]")).toBe("b");
    });
  });
});
