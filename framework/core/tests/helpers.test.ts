import { describe, expect, it } from "vitest";
import { Collection } from "../src/collection.js";
import { blank, collect, filled, retry, tap, value, withValue } from "../src/helpers.js";

describe("blank() / filled()", () => {
  it("treats null, undefined, empty/whitespace strings, and empty collections as blank", () => {
    expect(blank(null)).toBe(true);
    expect(blank(undefined)).toBe(true);
    expect(blank("")).toBe(true);
    expect(blank("  ")).toBe(true);
    expect(blank([])).toBe(true);
    expect(blank({})).toBe(true);
    expect(blank(Collection.empty())).toBe(true);
    expect(blank(new Map())).toBe(true);
    expect(blank(new Set())).toBe(true);
  });

  it("does not treat false, 0, or non-empty values as blank", () => {
    expect(blank(false)).toBe(false);
    expect(blank(0)).toBe(false);
    expect(blank("a")).toBe(false);
    expect(blank([1])).toBe(false);
    expect(blank({ a: 1 })).toBe(false);
    expect(filled("x")).toBe(true);
    expect(filled("")).toBe(false);
  });

  it("never treats non-plain objects (Date, class instances) as blank", () => {
    expect(blank(new Date())).toBe(false);
    expect(filled(new Date())).toBe(true);

    class Point {
      constructor(
        public x = 0,
        public y = 0,
      ) {}
    }
    expect(blank(new Point())).toBe(false);

    class Empty {}
    expect(blank(new Empty())).toBe(false);
  });
});

describe("value() / withValue() / tap()", () => {
  it("value() unwraps a thunk and returns a plain value as-is", () => {
    expect(value(3)).toBe(3);
    expect(value(() => 3)).toBe(3);
    expect(value((a: number, b: number) => a + b, 2, 3)).toBe(5);
  });

  it("withValue() returns the callback's result", () => {
    expect(withValue(2, (n) => n * 3)).toBe(6);
    expect(withValue(2)).toBe(2);
  });

  it("tap() runs a side-effect callback and returns the original value", () => {
    const seen: number[] = [];
    expect(tap(5, (n) => seen.push(n))).toBe(5);
    expect(seen).toEqual([5]);
    expect(tap(5)).toBe(5);
  });
});

describe("retry()", () => {
  it("returns on the first successful attempt", async () => {
    let calls = 0;
    await expect(
      retry(3, () => {
        calls += 1;

        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries until the callback succeeds", async () => {
    let calls = 0;
    await expect(
      retry(3, () => {
        calls += 1;

        if (calls < 3) {
          throw new Error("fail");
        }

        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows after exhausting attempts", async () => {
    await expect(
      retry(2, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not retry when when() returns false", async () => {
    let calls = 0;
    await expect(
      retry(
        5,
        () => {
          calls += 1;
          throw new Error("no");
        },
        0,
        () => false,
      ),
    ).rejects.toThrow("no");
    expect(calls).toBe(1);
  });

  it("sleeps between attempts when sleepMs is set", async () => {
    const started = Date.now();
    let calls = 0;
    await retry(
      2,
      () => {
        calls += 1;

        if (calls === 1) {
          throw new Error("once");
        }

        return "ok";
      },
      20,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("collect()", () => {
  it("wraps arrays, scalars, and null into a Collection", () => {
    expect(collect([1, 2]).all()).toEqual([1, 2]);
    expect(collect(1).all()).toEqual([1]);
    expect(collect(null).all()).toEqual([]);
    expect(collect().all()).toEqual([]);
  });

  it("clones an existing Collection", () => {
    const original = Collection.make([1, 2]);
    const wrapped = collect(original);
    expect(wrapped.all()).toEqual([1, 2]);
    expect(wrapped).not.toBe(original);
  });
});
