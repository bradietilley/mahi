import { describe, expect, it } from "vitest";
import { pooled } from "../src/helpers.js";

/** Resolves with `value` after `ms`, for ordering/concurrency assertions. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("pooled — array form", () => {
  it("preserves array position", async () => {
    const results = await pooled([
      () => after(30, "a"),
      () => after(10, "b"),
      () => after(20, "c"),
    ]);

    // Despite finishing in the order b, c, a.
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty input", async () => {
    expect(await pooled([])).toEqual([]);
  });

  it("runs unlimited concurrency by default", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++inFlight);
      await after(20, null);
      inFlight--;

      return "ok";
    };

    await pooled([task, task, task, task, task]);

    expect(peak).toBe(5);
  });
});

describe("pooled — record form", () => {
  it("preserves record keys", async () => {
    const results = await pooled({
      user: () => after(20, { id: 1 }),
      repos: () => after(5, { id: 2 }),
    });

    expect(results.user).toEqual({ id: 1 });
    expect(results.repos).toEqual({ id: 2 });
    expect(Object.keys(results)).toEqual(["user", "repos"]);
  });

  it("returns an empty record for empty input", async () => {
    expect(await pooled({})).toEqual({});
  });
});

describe("pooled — failures", () => {
  it("surfaces a rejection as an Error value without rejecting the pool", async () => {
    const results = await pooled([
      () => Promise.resolve("ok"),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve("also ok"),
    ]);

    expect(results[0]).toBe("ok");
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toBe("boom");
    // The key property: a failure in the middle does not discard the rest.
    expect(results[2]).toBe("also ok");
  });

  it("wraps a non-Error throw in an Error", async () => {
    const results = await pooled([() => Promise.reject("just a string")]);

    expect(results[0]).toBeInstanceOf(Error);
    expect((results[0] as Error).message).toBe("just a string");
  });

  it("keeps record keys when an entry fails", async () => {
    const results = await pooled({
      good: () => Promise.resolve(1),
      bad: () => Promise.reject(new Error("nope")),
    });

    expect(results.good).toBe(1);
    expect(results.bad).toBeInstanceOf(Error);
  });
});

describe("pooled — concurrency", () => {
  it("concurrency: 1 runs strictly sequentially", async () => {
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await after(10, null);
      log.push(`${name}:end`);

      return name;
    };

    await pooled([task("a"), task("b"), task("c")], { concurrency: 1 });

    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("concurrency: 2 bounds the peak in-flight count", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++inFlight);
      await after(15, null);
      inFlight--;

      return "ok";
    };

    await pooled([task, task, task, task, task, task], { concurrency: 2 });

    expect(peak).toBe(2);
  });

  it("a concurrency above the task count is harmless", async () => {
    const results = await pooled([() => after(5, 1), () => after(5, 2)], { concurrency: 10 });
    expect(results).toEqual([1, 2]);
  });

  it("rejects a concurrency below 1", async () => {
    await expect(pooled([() => after(1, 1)], { concurrency: 0 })).rejects.toThrow(RangeError);
  });
});
