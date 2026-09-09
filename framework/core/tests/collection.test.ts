import { describe, expect, it } from "vitest";
import { Collection, ItemNotFoundError, MultipleItemsFoundError } from "../src/collection.js";

interface Item {
  id: number;
  category: string;
}

const items: Item[] = [
  { id: 1, category: "a" },
  { id: 2, category: "b" },
  { id: 3, category: "a" },
];

describe("Collection — construction", () => {
  it("make() from a plain array keys items 0, 1, 2, ...", () => {
    const c = Collection.make(["x", "y"]);
    expect(c.keys().toArray()).toEqual([0, 1]);
    expect(c.toArray()).toEqual(["x", "y"]);
  });

  it("make() from a Map preserves keys", () => {
    const c = Collection.make(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
  });

  it("make() from a Collection clones it (mutating the copy doesn't affect the original)", () => {
    const original = Collection.make([1, 2, 3]);
    const copy = Collection.make(original);
    copy.push(4);
    expect(original.toArray()).toEqual([1, 2, 3]);
    expect(copy.toArray()).toEqual([1, 2, 3, 4]);
  });

  it("empty() creates a Collection with no items", () => {
    expect(Collection.empty().isEmpty()).toBe(true);
  });

  it("wrap() passes through arrays/Collections and wraps scalars", () => {
    expect(Collection.wrap([1, 2]).toArray()).toEqual([1, 2]);
    expect(Collection.wrap(5).toArray()).toEqual([5]);
  });

  it("unwrap() returns the underlying array from a Collection, or the value unchanged", () => {
    expect(Collection.unwrap(Collection.make([1, 2]))).toEqual([1, 2]);
    expect(Collection.unwrap([3, 4])).toEqual([3, 4]);
  });

  it("range() creates an inclusive numeric range", () => {
    expect(Collection.range(1, 5).toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(Collection.range(5, 1, -1).toArray()).toEqual([5, 4, 3, 2, 1]);
    expect(Collection.range(0, 10, 2).toArray()).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("times() invokes the callback n times (1-indexed)", () => {
    expect(Collection.times(3, (n) => n * 10).toArray()).toEqual([10, 20, 30]);
    expect(Collection.times(0).toArray()).toEqual([]);
  });

  it("fromJson() decodes a JSON array", () => {
    expect(Collection.fromJson("[1,2,3]").toArray()).toEqual([1, 2, 3]);
  });
});

describe("Collection — basic accessors", () => {
  it("toArray()/all() return a plain array of values", () => {
    expect(Collection.make(items).toArray()).toEqual(items);
    expect(Collection.make(items).all()).toEqual(items);
  });

  it("toJSON() supports JSON.stringify()", () => {
    expect(JSON.stringify(Collection.make([1, 2]))).toBe("[1,2]");
  });

  it("toJson() stringifies with optional indent", () => {
    expect(Collection.make([1, 2]).toJson()).toBe("[1,2]");
  });

  it("length/count() reflect the number of items", () => {
    const c = Collection.make([1, 2, 3]);
    expect(c.length).toBe(3);
    expect(c.count()).toBe(3);
  });

  it("isEmpty()/isNotEmpty() reflect emptiness", () => {
    expect(Collection.make([]).isEmpty()).toBe(true);
    expect(Collection.make([]).isNotEmpty()).toBe(false);
    expect(Collection.make([1]).isEmpty()).toBe(false);
    expect(Collection.make([1]).isNotEmpty()).toBe(true);
  });

  it("supports the iterator protocol over values", () => {
    expect([...Collection.make([1, 2, 3])]).toEqual([1, 2, 3]);
  });
});

describe("Collection — key-based access", () => {
  it("get() returns the value at a key, or the default if missing", () => {
    const c = Collection.make(["x", "y"]);
    expect(c.get(0)).toBe("x");
    expect(c.get(5)).toBeUndefined();
    expect(c.get(5, "fallback")).toBe("fallback");
    expect(c.get(5, () => "lazy")).toBe("lazy");
  });

  it("getOrPut() returns existing value, or sets+returns a new one", () => {
    const c = Collection.make(["x"]);
    expect(c.getOrPut(0, "y")).toBe("x");
    expect(c.getOrPut(1, () => "computed")).toBe("computed");
    expect(c.toArray()).toEqual(["x", "computed"]);
  });

  it("has()/hasAny() check key existence", () => {
    const c = Collection.make(["x", "y"]);
    expect(c.has(0)).toBe(true);
    expect(c.has([0, 1])).toBe(true);
    expect(c.has([0, 5])).toBe(false);
    expect(c.hasAny([5, 1])).toBe(true);
    expect(c.hasAny([5, 6])).toBe(false);
    expect(Collection.empty().hasAny([0])).toBe(false);
  });

  it("put() sets a value at a key, mutating in place", () => {
    const c = Collection.make(["x", "y"]);
    const result = c.put(0, "z");
    expect(result).toBe(c);
    expect(c.toArray()).toEqual(["z", "y"]);
  });

  it("pull() gets and removes an item by key, mutating in place", () => {
    const c = Collection.make(["x", "y"]);
    expect(c.pull(0)).toBe("x");
    expect(c.toArray()).toEqual(["y"]);
    expect(c.pull(99, "fallback")).toBe("fallback");
  });

  it("forget() removes one or more keys, mutating in place", () => {
    const c = Collection.make(["x", "y", "z"]);
    const result = c.forget([0, 2]);
    expect(result).toBe(c);
    expect(c.keys().toArray()).toEqual([1]);
  });

  it("only()/except() return new Collections filtered by key", () => {
    const c = Collection.make(["x", "y", "z"]);
    expect(c.only([0, 2]).toArray()).toEqual(["x", "z"]);
    expect(c.except([1]).toArray()).toEqual(["x", "z"]);
    // non-mutating
    expect(c.toArray()).toEqual(["x", "y", "z"]);
  });

  it("keys() returns a Collection of keys; values() resets to sequential keys", () => {
    const c = Collection.make(items).keyBy((i) => i.category);
    expect([...c.keys()].sort()).toEqual(["a", "b"]);
    expect(c.values().keys().toArray()).toEqual([0, 1]);
  });
});

describe("Collection — structural mutation", () => {
  it("push()/add() append items and mutate in place, returning this", () => {
    const c = Collection.make([1, 2]);
    const result = c.push(3, 4);
    expect(result).toBe(c);
    expect(c.toArray()).toEqual([1, 2, 3, 4]);
    c.add(5);
    expect(c.toArray()).toEqual([1, 2, 3, 4, 5]);
  });

  it("unshift() prepends items, renumbering keys, mutating in place", () => {
    const c = Collection.make([3, 4]);
    const result = c.unshift(1, 2);
    expect(result).toBe(c);
    expect(c.toArray()).toEqual([1, 2, 3, 4]);
    expect(c.keys().toArray()).toEqual([0, 1, 2, 3]);
  });

  it("prepend() adds a single item to the front, mutating in place", () => {
    const c = Collection.make([2, 3]);
    c.prepend(1);
    expect(c.toArray()).toEqual([1, 2, 3]);
  });

  it("pop() removes and returns the last item (or a Collection of N), mutating in place", () => {
    const c = Collection.make([1, 2, 3]);
    expect(c.pop()).toBe(3);
    expect(c.toArray()).toEqual([1, 2]);

    const c2 = Collection.make([1, 2, 3, 4]);
    // Laravel returns popped items last-first: pop(2) → [4, 3].
    expect(c2.pop(2).toArray()).toEqual([4, 3]);
    expect(c2.toArray()).toEqual([1, 2]);

    expect(Collection.empty<number>().pop()).toBeUndefined();
  });

  it("shift() removes and returns the first item (or a Collection of N), mutating in place", () => {
    const c = Collection.make([1, 2, 3]);
    expect(c.shift()).toBe(1);
    expect(c.toArray()).toEqual([2, 3]);

    const c2 = Collection.make([1, 2, 3, 4]);
    expect(c2.shift(2).toArray()).toEqual([1, 2]);
    expect(c2.toArray()).toEqual([3, 4]);

    expect(Collection.empty<number>().shift()).toBeUndefined();
  });

  it("splice() removes/replaces a portion in place and returns the removed portion", () => {
    const c = Collection.make([1, 2, 3, 4, 5]);
    const removed = c.splice(1, 2, [10, 20, 30]);
    expect(removed.toArray()).toEqual([2, 3]);
    expect(c.toArray()).toEqual([1, 10, 20, 30, 4, 5]);
  });

  it("transform() maps items in place", () => {
    const c = Collection.make([1, 2, 3]);
    const result = c.transform((n) => n * 10);
    expect(result).toBe(c);
    expect(c.toArray()).toEqual([10, 20, 30]);
  });
});

describe("Collection — iteration/transformation", () => {
  it("each() iterates and stops early on `false`", () => {
    const seen: number[] = [];
    Collection.make([1, 2, 3, 4]).each((n) => {
      seen.push(n);

      if (n === 2) {
        return false;
      }

      return undefined;
    });
    expect(seen).toEqual([1, 2]);
  });

  it("map() transforms values into a new Collection", () => {
    const result = Collection.make([1, 2, 3]).map((n) => n * 2);
    expect(result).toBeInstanceOf(Collection);
    expect(result.toArray()).toEqual([2, 4, 6]);
  });

  it("mapValues() transforms values and keeps keys", () => {
    const result = Collection.make(new Map(Object.entries({ a: 1, b: 2 }))).mapValues((n) => n * 2);

    expect([...result.keys().toArray()]).toEqual(["a", "b"]);
    expect(result.all()).toEqual([2, 4]);
  });

  it("mapValues() preserves keys where map() renumbers them", () => {
    // The distinction the method exists for: map() is list-shaped, so on
    // a keyed collection it discards exactly the thing that made it keyed.
    const source = Collection.make(new Map(Object.entries({ x: 1, y: 2 })));

    expect(
      source
        .mapValues((n) => n * 10)
        .keys()
        .toArray(),
    ).toEqual(["x", "y"]);
    expect(
      source
        .map((n) => n * 10)
        .keys()
        .toArray(),
    ).toEqual([0, 1]);
  });

  it("mapValues() passes the key to the callback", () => {
    const result = Collection.make(new Map(Object.entries({ a: 1, b: 2 }))).mapValues(
      (n, k) => `${k}${n}`,
    );

    expect(result.all()).toEqual(["a1", "b2"]);
  });

  it("mapValues() keeps insertion order", () => {
    const result = Collection.make(new Map(Object.entries({ b: 1, a: 2 }))).mapValues((n) => n);

    expect(result.keys().toArray()).toEqual(["b", "a"]);
  });

  it("mapValues() on a list keeps the numeric keys", () => {
    const result = Collection.make([10, 20]).mapValues((n) => n + 1);

    expect(result.toArray()).toEqual([11, 21]);
    expect(result.keys().toArray()).toEqual([0, 1]);
  });

  it("mapWithKeys() maps to [key, value] pairs", () => {
    const result = Collection.make(items).mapWithKeys((i) => [i.category, i.id]);
    expect(result.get("a")).toBe(3); // later duplicate wins
    expect(result.get("b")).toBe(2);
  });

  it("mapToDictionary() groups callback results by key into a Collection", () => {
    const result = Collection.make(items).mapToDictionary((i) => [i.category, i.id]);
    expect(result).toBeInstanceOf(Collection);
    expect(result.get("a")).toEqual([1, 3]);
    expect(result.get("b")).toEqual([2]);
  });

  it("mapToGroups() is mapToDictionary with Collection-wrapped groups", () => {
    const result = Collection.make(items).mapToGroups((i) => [i.category, i.id]);
    expect(result).toBeInstanceOf(Collection);
    expect(result.get("a")?.toArray()).toEqual([1, 3]);
  });

  it("flatMap() maps then flattens by one level", () => {
    const result = Collection.make([1, 2, 3]).flatMap((n) => [n, n * 10]);
    expect(result.toArray()).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("mapSpread() spreads tuple items as positional args plus key", () => {
    const result = Collection.make([
      [1, 2],
      [3, 4],
    ]).mapSpread((a, b) => (a as number) + (b as number));
    expect(result.toArray()).toEqual([3, 7]);
  });

  it("mapInto() constructs new instances", () => {
    class Wrapper {
      constructor(public value: number) {}
    }
    const result = Collection.make([1, 2]).mapInto(Wrapper);
    expect(result.toArray()[0]).toBeInstanceOf(Wrapper);
    expect(result.toArray()[0]?.value).toBe(1);
  });

  it("eachSpread() spreads tuple items as positional args plus key", () => {
    const seen: number[] = [];
    Collection.make([[1, 2]]).eachSpread((a, b) => {
      seen.push((a as number) + (b as number));
    });
    expect(seen).toEqual([3]);
  });

  it("reduce() folds to a single value", () => {
    expect(Collection.make([1, 2, 3]).reduce((acc, n) => acc + n, 0)).toBe(6);
  });

  it("reduceInto() folds by mutating the initial value", () => {
    const result = Collection.make([1, 2, 3]).reduceInto({ total: 0 }, (acc, n) => {
      acc.total += n;
    });
    expect(result).toEqual({ total: 6 });
  });

  it("reduceSpread() folds to multiple aggregate values", () => {
    const [sum, count] = Collection.make([1, 2, 3]).reduceSpread(
      (sum, count, n) => [(sum as number) + (n as number), (count as number) + 1],
      0,
      0,
    );
    expect([sum, count]).toEqual([6, 3]);
  });

  it("reduceSpread() throws if the reducer doesn't return an array", () => {
    expect(() => Collection.make([1]).reduceSpread(() => 5 as unknown as unknown[], 0)).toThrow();
  });
});

describe("Collection — filtering/searching", () => {
  it("filter() keeps matching items; with no args drops falsy items", () => {
    expect(
      Collection.make([1, 2, 3, 4])
        .filter((n) => n % 2 === 0)
        .toArray(),
    ).toEqual([2, 4]);
    expect(Collection.make([0, 1, "", "x", null]).filter().toArray()).toEqual([1, "x"]);
  });

  it("reject() keeps non-matching items", () => {
    expect(
      Collection.make([1, 2, 3, 4])
        .reject((n) => n % 2 === 0)
        .toArray(),
    ).toEqual([1, 3]);
  });

  it("where() filters by key/value, or key/operator/value", () => {
    expect(Collection.make(items).where("category", "a").toArray()).toEqual([items[0], items[2]]);
    expect(Collection.make(items).where("id", ">", 1).toArray()).toEqual([items[1], items[2]]);
  });

  it("whereNull()/whereNotNull() filter by nullish key values", () => {
    const data = [{ v: null }, { v: 1 }, { v: undefined }];
    expect(Collection.make(data).whereNull("v").toArray()).toEqual([{ v: null }, { v: undefined }]);
    expect(Collection.make(data).whereNotNull("v").toArray()).toEqual([{ v: 1 }]);
  });

  it("whereIn()/whereNotIn() filter by membership", () => {
    expect(Collection.make(items).whereIn("category", ["a"]).toArray()).toEqual([
      items[0],
      items[2],
    ]);
    expect(Collection.make(items).whereNotIn("category", ["a"]).toArray()).toEqual([items[1]]);
  });

  it("whereBetween()/whereNotBetween() filter by range", () => {
    expect(Collection.make(items).whereBetween("id", [2, 3]).toArray()).toEqual([
      items[1],
      items[2],
    ]);
    expect(Collection.make(items).whereNotBetween("id", [2, 3]).toArray()).toEqual([items[0]]);
  });

  it("whereInstanceOf() filters and narrows by constructor", () => {
    class A {}
    class B {}
    const a = new A();
    const b = new B();
    const result = Collection.make<A | B>([a, b]).whereInstanceOf(A);
    expect(result.toArray()).toEqual([a]);
  });

  it("first()/last() optionally accept a predicate", () => {
    const c = Collection.make(items);
    expect(c.first()).toBe(items[0]);
    expect(c.first((i) => i.category === "b")).toBe(items[1]);
    expect(c.last()).toBe(items[2]);
    expect(c.last((i) => i.category === "a")).toBe(items[2]);
    expect(Collection.empty().first()).toBeUndefined();
  });

  it("firstOrFail() throws ItemNotFoundError when nothing matches", () => {
    expect(() => Collection.make(items).firstOrFail((i) => i.category === "z")).toThrow(
      ItemNotFoundError,
    );
    expect(Collection.make(items).firstOrFail((i) => i.category === "b")).toBe(items[1]);
  });

  it("firstWhere() finds the first item by key/value pair", () => {
    expect(Collection.make(items).firstWhere("category", "a")).toBe(items[0]);
    expect(Collection.make(items).firstWhere("id", ">", 1)).toBe(items[1]);
  });

  it("sole() returns the single matching item or throws a dedicated error", () => {
    expect(Collection.make(items).sole((i) => i.category === "b")).toBe(items[1]);
    expect(() => Collection.make(items).sole((i) => i.category === "a")).toThrow(
      MultipleItemsFoundError,
    );
    expect(() => Collection.make(items).sole((i) => i.category === "z")).toThrow(ItemNotFoundError);
  });

  it("hasSole()/hasMany() report cardinality", () => {
    expect(Collection.make(items).hasSole((i) => i.category === "b")).toBe(true);
    expect(Collection.make(items).hasMany((i) => i.category === "a")).toBe(true);
    expect(Collection.make(items).hasSole((i) => i.category === "a")).toBe(false);
    expect(Collection.make(items).hasMany((i) => i.category === "b")).toBe(false);
  });

  it("contains()/some()/doesntContain() test membership by value or predicate", () => {
    const c = Collection.make([1, 2, 3]);
    expect(c.contains(2)).toBe(true);
    expect(c.contains((n) => n > 2)).toBe(true);
    expect(c.some(4)).toBe(false);
    expect(c.doesntContain(4)).toBe(true);
  });

  it("every() checks all items match", () => {
    expect(Collection.make([2, 4, 6]).every((n) => n % 2 === 0)).toBe(true);
    expect(Collection.make([2, 3, 6]).every((n) => n % 2 === 0)).toBe(false);
  });

  it("search() returns the matching key, or false (like Laravel)", () => {
    expect(Collection.make(["a", "b", "c"]).search("b")).toBe(1);
    expect(Collection.make(["a", "b", "c"]).search((v) => v === "z")).toBe(false);
  });

  it("before()/after() return neighboring items in iteration order", () => {
    const c = Collection.make([1, 2, 3]);
    expect(c.before(2)).toBe(1);
    expect(c.after(2)).toBe(3);
    expect(c.before(1)).toBeUndefined();
    expect(c.after(3)).toBeUndefined();
    expect(c.before(99)).toBeUndefined();
  });

  it("ensure() throws if any item fails the given predicate", () => {
    expect(() => Collection.make([1, 2, "x"]).ensure((v) => typeof v === "number")).toThrow();
    expect(Collection.make([1, 2, 3]).ensure((v) => typeof v === "number")).toBeInstanceOf(
      Collection,
    );
  });

  it("ensure(Class) reports a TypeError with the failing-check message, not a construct error", () => {
    class Foo {}
    expect(Collection.make([new Foo(), new Foo()]).ensure(Foo)).toBeInstanceOf(Collection);
    expect(() => Collection.make([new Foo(), 5]).ensure(Foo)).toThrow(
      /failed the ensure\(\) check/,
    );
  });
});

describe("Collection — grouping/keying", () => {
  it("groupBy() groups items by key into a Collection, preserving duplicates within a group", () => {
    const grouped = Collection.make(items).groupBy((i) => i.category);
    expect(grouped).toBeInstanceOf(Collection);
    expect(grouped.get("a")?.toArray()).toEqual([items[0], items[2]]);
    expect(grouped.get("b")?.toArray()).toEqual([items[1]]);
  });

  it("keyBy() keys items by a derived key, later duplicates overwriting earlier ones", () => {
    const keyed = Collection.make([
      { id: 1, category: "a" },
      { id: 2, category: "a" },
    ]).keyBy((i) => i.category);
    expect(keyed.get("a")).toEqual({ id: 2, category: "a" });
    expect(keyed.count()).toBe(1);
  });

  it("keyBy() supports property-name selectors and returns a string-keyed Collection", () => {
    interface User {
      email: string;
      name: string;
    }
    const users: User[] = [
      { email: "a@x.com", name: "A" },
      { email: "b@x.com", name: "B" },
    ];
    const keyed = Collection.make(users).keyBy("email");
    expect(keyed.get("a@x.com")).toEqual(users[0]);
    expect(keyed.get("b@x.com")).toEqual(users[1]);
  });

  it("countBy() counts occurrences per derived key into a Collection", () => {
    const counts = Collection.make(items).countBy((i) => i.category);
    expect(counts).toBeInstanceOf(Collection);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
  });

  it("partition() splits into [matching, notMatching]", () => {
    const [evens, odds] = Collection.make([1, 2, 3, 4]).partition((n) => n % 2 === 0);
    expect(evens.toArray()).toEqual([2, 4]);
    expect(odds.toArray()).toEqual([1, 3]);
  });

  it("duplicates() returns a Collection of duplicate values (by identity, or a derived key), keeping keys", () => {
    expect(Collection.make([1, 2, 2, 3, 1]).duplicates().toArray()).toEqual([2, 1]);
    expect(
      Collection.make(items)
        .duplicates((i) => i.category)
        .toArray(),
    ).toEqual([items[2]]);
  });
});

describe("Collection — aggregates", () => {
  it("sum() totals values, optionally via a selector", () => {
    expect(Collection.make([1, 2, 3]).sum()).toBe(6);
    expect(Collection.make(items).sum((i) => i.id)).toBe(6);
    expect(Collection.make(items).sum("id")).toBe(6);
  });

  it("avg()/average() compute the mean", () => {
    expect(Collection.make([1, 2, 3]).avg()).toBe(2);
    expect(Collection.make([1, 2, 3]).average()).toBe(2);
    expect(Collection.empty<number>().avg()).toBeUndefined();
  });

  it("min()/max() find extremes, optionally via a selector", () => {
    expect(Collection.make([3, 1, 2]).min()).toBe(1);
    expect(Collection.make([3, 1, 2]).max()).toBe(3);
    expect(Collection.make(items).min((i) => i.id)).toBe(1);
    expect(Collection.make(items).max("id")).toBe(3);
  });

  it("median() computes the middle value (averaging the two middles for even counts)", () => {
    expect(Collection.make([3, 1, 2]).median()).toBe(2);
    expect(Collection.make([1, 2, 3, 4]).median()).toBe(2.5);
    expect(Collection.empty<number>().median()).toBeUndefined();
  });

  it("mode() returns the most frequent value(s)", () => {
    expect(Collection.make([1, 1, 2, 3]).mode()).toEqual([1]);
    expect(Collection.make([1, 1, 2, 2]).mode()).toEqual([1, 2]);
    expect(Collection.empty<number>().mode()).toBeUndefined();
  });

  it("percentage() computes the percent passing a predicate", () => {
    expect(Collection.make([1, 2, 3, 4]).percentage((n) => n % 2 === 0)).toBe(50);
    expect(Collection.empty<number>().percentage(() => true)).toBeUndefined();
  });
});

describe("Collection — slicing/paging", () => {
  it("take() takes from the front (or end, if negative)", () => {
    expect(Collection.make([1, 2, 3, 4]).take(2).toArray()).toEqual([1, 2]);
    expect(Collection.make([1, 2, 3, 4]).take(-2).toArray()).toEqual([3, 4]);
  });

  it("skip() skips from the front", () => {
    expect(Collection.make([1, 2, 3, 4]).skip(2).toArray()).toEqual([3, 4]);
  });

  it("slice() extracts a sub-range", () => {
    expect(Collection.make([1, 2, 3, 4, 5]).slice(1, 2).toArray()).toEqual([2, 3]);
    expect(Collection.make([1, 2, 3, 4, 5]).slice(-2).toArray()).toEqual([4, 5]);
  });

  it("forPage() paginates by page number", () => {
    expect(Collection.make([1, 2, 3, 4, 5]).forPage(2, 2).toArray()).toEqual([3, 4]);
  });

  it("takeUntil()/takeWhile() take items until/while a condition holds", () => {
    expect(
      Collection.make([1, 2, 3, 4])
        .takeUntil((n) => n === 3)
        .toArray(),
    ).toEqual([1, 2]);
    expect(
      Collection.make([1, 2, 3, 4])
        .takeWhile((n) => n < 3)
        .toArray(),
    ).toEqual([1, 2]);
  });

  it("skipUntil()/skipWhile() skip items until/while a condition holds", () => {
    expect(
      Collection.make([1, 2, 3, 4])
        .skipUntil((n) => n === 3)
        .toArray(),
    ).toEqual([3, 4]);
    expect(
      Collection.make([1, 2, 3, 4])
        .skipWhile((n) => n < 3)
        .toArray(),
    ).toEqual([3, 4]);
  });

  it("nth() takes every n-th element with an optional offset", () => {
    expect(Collection.make([1, 2, 3, 4, 5, 6]).nth(2).toArray()).toEqual([1, 3, 5]);
    expect(Collection.make([1, 2, 3, 4, 5, 6]).nth(2, 1).toArray()).toEqual([2, 4, 6]);
    expect(() => Collection.make([1]).nth(0)).toThrow();
  });
});

describe("Collection — chunking/splitting", () => {
  // Generic in the item type: `Collection` is invariant in its value
  // parameter (its methods take `this`), so a
  // `Collection<Collection<number, …>, …>` is NOT assignable to a
  // `Collection<Collection<unknown, …>, …>`.
  const nested = <T>(c: Collection<Collection<T, number>, number>) =>
    c.toArray().map((g) => g.toArray());

  it("chunk() splits into groups of the given size, including a remainder chunk", () => {
    const result = Collection.make([1, 2, 3, 4, 5]).chunk(2);
    expect(result).toBeInstanceOf(Collection);
    expect(nested(result)).toEqual([[1, 2], [3, 4], [5]]);
    expect(nested(Collection.make([1]).chunk(0))).toEqual([]);
  });

  it("chunkWhile() starts a new chunk when the callback returns false", () => {
    const result = Collection.make([1, 2, 4, 5, 7]).chunkWhile((_item, _key, chunk) => {
      const last = chunk.last() as number;

      return _item === last + 1;
    });
    expect(nested(result)).toEqual([[1, 2], [4, 5], [7]]);
  });

  it("sliding() creates overlapping windows", () => {
    expect(nested(Collection.make([1, 2, 3, 4]).sliding(2))).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(nested(Collection.make([1, 2, 3, 4]).sliding(2, 2))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("split() splits into roughly-equal groups, remainder distributed to first groups", () => {
    expect(nested(Collection.make([1, 2, 3, 4, 5]).split(2))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(nested(Collection.empty().split(3))).toEqual([]);
  });

  it("splitIn() fills earlier groups completely first", () => {
    expect(nested(Collection.make([1, 2, 3, 4, 5]).splitIn(2))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });
});

describe("Collection — ordering", () => {
  it("sort() sorts ascending by default, or with a custom comparator", () => {
    expect(Collection.make([3, 1, 2]).sort().toArray()).toEqual([1, 2, 3]);
    expect(
      Collection.make([3, 1, 2])
        .sort((a, b) => b - a)
        .toArray(),
    ).toEqual([3, 2, 1]);
  });

  it("sortDesc() sorts descending", () => {
    expect(Collection.make([3, 1, 2]).sortDesc().toArray()).toEqual([3, 2, 1]);
  });

  it("sortBy()/sortByDesc() sort by a derived key", () => {
    expect(Collection.make(items).sortBy("id").pluck("id").toArray()).toEqual([1, 2, 3]);
    expect(Collection.make(items).sortByDesc("id").pluck("id").toArray()).toEqual([3, 2, 1]);
  });

  it("sort() orders Dates chronologically, not lexically by String()", () => {
    const jan = new Date("2020-01-01T00:00:00Z"); // "Wed..."
    const feb = new Date("2020-02-01T00:00:00Z"); // "Sat..."
    const mar = new Date("2020-03-01T00:00:00Z"); // "Sun..."
    const sorted = Collection.make([mar, jan, feb]).sort().toArray();
    expect(sorted).toEqual([jan, feb, mar]);
  });

  it("sortBy() orders a Date-valued key chronologically", () => {
    const rows = [
      { createdAt: new Date("2021-06-01T00:00:00Z") },
      { createdAt: new Date("2021-01-01T00:00:00Z") },
      { createdAt: new Date("2021-12-01T00:00:00Z") },
    ];
    const order = Collection.make(rows)
      .sortBy("createdAt")
      .pluck("createdAt")
      .map((d) => (d as Date).getUTCMonth())
      .toArray();
    expect(order).toEqual([0, 5, 11]);
  });

  it("sort() orders bigints numerically, not lexically", () => {
    const sorted = Collection.make([10n, 2n, 100n]).sort().toArray();
    expect(sorted).toEqual([2n, 10n, 100n]);
  });

  it("sort() orders objects with a numeric valueOf() (e.g. DateTime) by that value", () => {
    const at = (ms: number) => ({ valueOf: () => ms });
    const a = at(3000);
    const b = at(1000);
    const c = at(2000);
    expect(Collection.make([a, b, c]).sort().toArray()).toEqual([b, c, a]);
  });

  it("sortKeys()/sortKeysDesc() sort by key", () => {
    const c = Collection.make(
      new Map([
        ["b", 1],
        ["a", 2],
      ]),
    );
    expect(c.sortKeys().keys().toArray()).toEqual(["a", "b"]);
    expect(c.sortKeysDesc().keys().toArray()).toEqual(["b", "a"]);
  });

  it("sortKeysUsing() sorts by a custom key comparator", () => {
    const c = Collection.make(
      new Map([
        ["bb", 1],
        ["a", 2],
      ]),
    );
    const result = c.sortKeysUsing((a, b) => a.length - b.length);
    expect(result.keys().toArray()).toEqual(["a", "bb"]);
  });

  it("reverse() reverses item order, preserving keys", () => {
    expect(Collection.make([1, 2, 3]).reverse().toArray()).toEqual([3, 2, 1]);
  });

  it("shuffle() returns a Collection with the same items in some order", () => {
    const c = Collection.make([1, 2, 3, 4, 5]);
    const shuffled = c.shuffle();
    expect(shuffled.toArray().sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("random() returns one item, or a Collection of N items", () => {
    const c = Collection.make([1, 2, 3]);
    expect([1, 2, 3]).toContain(c.random());
    expect(c.random(2).count()).toBe(2);
    expect(Collection.empty<number>().random()).toBeUndefined();
  });
});

describe("Collection — uniqueness", () => {
  it("unique() without a selector dedupes by identity/value", () => {
    expect(Collection.make([1, 2, 2, 3, 1]).unique().toArray()).toEqual([1, 2, 3]);
  });

  it("unique() with a selector dedupes by the derived key", () => {
    const result = Collection.make(items).unique((i) => i.category);
    expect(result.toArray()).toEqual([items[0], items[1]]);
  });
});

describe("Collection — merging/combining/set ops", () => {
  it("merge() overwrites matching keys, adds new ones", () => {
    const a = Collection.make(
      new Map<string, number>([
        ["x", 1],
        ["y", 2],
      ]),
    );
    const b = a.merge(
      new Map<string, number>([
        ["y", 20],
        ["z", 3],
      ]),
    );
    expect(b.get("x")).toBe(1);
    expect(b.get("y")).toBe(20);
    expect(b.get("z")).toBe(3);
    // non-mutating
    expect(a.get("y")).toBe(2);
  });

  it("merge(Collection) renumbers list-shaped collections instead of overwriting by index", () => {
    const merged = Collection.make([1, 2]).merge(Collection.make([3, 4]));
    // Laravel: array_merge([1,2], [3,4]) === [1,2,3,4]
    expect(merged.toArray()).toEqual([1, 2, 3, 4]);
    expect(merged.keys().toArray()).toEqual([0, 1, 2, 3]);
  });

  it("merge(array) and merge(list-Collection) agree", () => {
    const base = Collection.make([1, 2]);
    expect(base.merge([3, 4]).toArray()).toEqual(base.merge(Collection.make([3, 4])).toArray());
  });

  it("union() with a list-shaped collection also appends", () => {
    const merged = Collection.make([1, 2]).union(Collection.make([3, 4]));
    expect(merged.toArray()).toEqual([1, 2, 3, 4]);
  });

  it("merge() still overwrites on string-key collision (associative collections)", () => {
    const a = Collection.make(new Map<string, number>([["x", 1]]));
    const b = a.merge(
      Collection.make(
        new Map<string, number>([
          ["x", 9],
          ["y", 2],
        ]),
      ),
    );
    expect(b.get("x")).toBe(9);
    expect(b.get("y")).toBe(2);
  });

  it("mergeRecursive() deep-merges object values at colliding keys", () => {
    const a = Collection.make(new Map<string, any>([["x", { a: 1 }]]));
    const b = a.mergeRecursive(new Map<string, any>([["x", { b: 2 }]]));
    expect(b.get("x")).toEqual({ a: 1, b: 2 });
  });

  it("union() keeps existing keys, adds new ones (opposite bias from merge)", () => {
    const a = Collection.make(new Map<string, number>([["x", 1]]));
    const b = a.union(
      new Map<string, number>([
        ["x", 99],
        ["y", 2],
      ]),
    );
    expect(b.get("x")).toBe(1);
    expect(b.get("y")).toBe(2);
  });

  it("replace()/replaceRecursive() behave like merge()/mergeRecursive()", () => {
    const a = Collection.make(new Map<string, number>([["x", 1]]));
    expect(a.replace(new Map([["x", 2]])).get("x")).toBe(2);
  });

  it("concat() appends another iterable's values as a new list, discarding original keys", () => {
    const c = Collection.make(new Map([["a", 1]])).concat([2, 3]);
    expect(c.toArray()).toEqual([1, 2, 3]);
    expect(c.keys().toArray()).toEqual([0, 1, 2]);
  });

  it("multiply() repeats every item n times into a new list", () => {
    expect(Collection.make([1, 2]).multiply(3).all()).toEqual([1, 2, 1, 2, 1, 2]);
    expect(Collection.make([1]).multiply(0).all()).toEqual([]);
  });

  it("diff()/diffUsing() return items not present in the given iterable", () => {
    expect(Collection.make([1, 2, 3]).diff([2, 3]).toArray()).toEqual([1]);
    expect(
      Collection.make([1, 2, 3])
        .diffUsing([2, 3], (a, b) => a - b)
        .toArray(),
    ).toEqual([1]);
  });

  it("intersect()/intersectUsing() return items present in the given iterable", () => {
    expect(Collection.make([1, 2, 3]).intersect([2, 3]).toArray()).toEqual([2, 3]);
    expect(
      Collection.make([1, 2, 3])
        .intersectUsing([2, 3], (a, b) => a - b)
        .toArray(),
    ).toEqual([2, 3]);
  });

  it("crossJoin() returns all combinations", () => {
    const result = Collection.make([1, 2]).crossJoin(["a", "b"]);
    expect(result.toArray()).toEqual([
      [1, "a"],
      [1, "b"],
      [2, "a"],
      [2, "b"],
    ]);
  });

  it("combine() uses this collection's values as keys, paired with given values", () => {
    const result = Collection.make(["a", "b"]).combine([1, 2]);
    expect(result.get("a")).toBe(1);
    expect(result.get("b")).toBe(2);
  });

  it("flip() swaps keys and values", () => {
    const result = Collection.make(["a", "b"]).flip();
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(1);
  });

  it("zip() zips with one or more arrays", () => {
    const result = Collection.make([1, 2, 3]).zip(["a", "b", "c"]);
    expect(result.toArray()).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
  });

  it("pad() pads to a given size (positive pads end, negative pads start)", () => {
    expect(Collection.make([1, 2]).pad(4, 0).toArray()).toEqual([1, 2, 0, 0]);
    expect(Collection.make([1, 2]).pad(-4, 0).toArray()).toEqual([0, 0, 1, 2]);
    expect(Collection.make([1, 2, 3]).pad(2, 0).toArray()).toEqual([1, 2, 3]);
  });
});

describe("Collection — flatten/collapse", () => {
  it("flatten() recursively flattens, respecting an optional depth", () => {
    expect(
      Collection.make([1, [2, [3, [4]]]])
        .flatten()
        .toArray(),
    ).toEqual([1, 2, 3, 4]);
    expect(
      Collection.make([1, [2, [3, [4]]]])
        .flatten(1)
        .toArray(),
    ).toEqual([1, 2, [3, [4]]]);
  });

  it("collapse() flattens one level of nested arrays/Collections", () => {
    expect(
      Collection.make([
        [1, 2],
        [3, 4],
      ])
        .collapse()
        .toArray(),
    ).toEqual([1, 2, 3, 4]);
    expect(
      Collection.make([Collection.make([1, 2]), Collection.make([3])])
        .collapse()
        .toArray(),
    ).toEqual([1, 2, 3]);
  });
});

describe("Collection — column extraction", () => {
  it("pluck() extracts a single column into a Collection", () => {
    const result = Collection.make(items).pluck("id");
    expect(result).toBeInstanceOf(Collection);
    expect(result.toArray()).toEqual([1, 2, 3]);
  });

  it("pluck() with a key column re-keys the result", () => {
    const result = Collection.make(items).pluck("id", "category");
    expect(result.get("a")).toBe(3); // later duplicate wins
    expect(result.get("b")).toBe(2);
  });

  it("select() picks only the given properties from each item", () => {
    const result = Collection.make(items).select(["id"]);
    expect(result.toArray()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});

describe("Collection — string conversion", () => {
  it("implode() concatenates a column's values, or the whole item for scalars", () => {
    expect(Collection.make(items).implode("category", ",")).toBe("a,b,a");
    expect(Collection.make([1, 2, 3]).implode((n) => n, "-")).toBe("1-2-3");
  });

  it("join() joins with a different glue before the final item", () => {
    expect(Collection.make(["a", "b", "c"]).join(", ", " and ")).toBe("a, b and c");
    expect(Collection.make(["a"]).join(", ", " and ")).toBe("a");
    expect(Collection.empty().join(", ", " and ")).toBe("");
    expect(Collection.make(["a", "b"]).join(", ")).toBe("a, b");
  });
});

describe("Collection — flow control/conditionals", () => {
  it("pipe() passes the collection to a callback and returns its result", () => {
    const result = Collection.make([1, 2, 3]).pipe((c) => c.count());
    expect(result).toBe(3);
  });

  it("tap() passes the collection to a callback for side effects, returning itself", () => {
    const seen: number[] = [];
    const c = Collection.make([1, 2]);
    const result = c.tap((coll) => seen.push(coll.count()));
    expect(result).toBe(c);
    expect(seen).toEqual([2]);
  });

  it("when()/unless() conditionally invoke a callback", () => {
    const c = Collection.make([1, 2]);
    expect(c.when(true, (coll) => coll.count())).toBe(2);
    expect(
      c.when(
        false,
        (coll) => coll.count(),
        () => "default",
      ),
    ).toBe("default");
    expect(c.unless(false, (coll) => coll.count())).toBe(2);
  });

  it("whenEmpty()/whenNotEmpty()/unlessEmpty()/unlessNotEmpty() branch on emptiness", () => {
    expect(Collection.empty().whenEmpty(() => "was empty")).toBe("was empty");
    expect(Collection.make([1]).whenNotEmpty(() => "has items")).toBe("has items");
    expect(Collection.make([1]).unlessEmpty(() => "has items")).toBe("has items");
    expect(Collection.empty().unlessNotEmpty(() => "was empty")).toBe("was empty");
  });
});

describe("Collection — immutability contract", () => {
  it("non-mutating methods never affect the original collection", () => {
    const original = Collection.make([3, 1, 2]);
    original.map((n) => n * 2);
    original.filter((n) => n > 1);
    original.sort();
    original.reverse();
    original.unique();
    original.slice(1);
    expect(original.toArray()).toEqual([3, 1, 2]);
  });

  it("toArray() returns a defensive copy, not a live view", () => {
    const collection = Collection.make([1, 2, 3]);
    const array = collection.toArray();
    array.push(4);
    expect(collection.toArray()).toEqual([1, 2, 3]);
  });
});
