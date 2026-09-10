import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArrayCacheStore } from "../../src/stores/array-cache-store.js";

describe("ArrayCacheStore", () => {
  it("get() returns undefined for a missing key", async () => {
    const store = new ArrayCacheStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("put()/get() round-trips a value", async () => {
    const store = new ArrayCacheStore();
    await store.put("key", { a: 1 });
    expect(await store.get("key")).toEqual({ a: 1 });
  });

  it("forget() removes a key", async () => {
    const store = new ArrayCacheStore();
    await store.put("key", "value");
    await store.forget("key");
    expect(await store.get("key")).toBeUndefined();
  });

  it("has() reflects presence", async () => {
    const store = new ArrayCacheStore();
    expect(await store.has("key")).toBe(false);
    await store.put("key", "value");
    expect(await store.has("key")).toBe(true);
  });

  it("flush() clears every key", async () => {
    const store = new ArrayCacheStore();
    await store.put("a", 1);
    await store.put("b", 2);
    await store.flush();
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeUndefined();
  });

  describe("TTL expiry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a value with a ttlSeconds expires after that many seconds", async () => {
      const store = new ArrayCacheStore();
      await store.put("key", "value", 10);
      expect(await store.get("key")).toBe("value");

      vi.advanceTimersByTime(10_001);
      expect(await store.get("key")).toBeUndefined();
    });

    it("a value with no ttlSeconds never expires", async () => {
      const store = new ArrayCacheStore();
      await store.put("key", "value");
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);
      expect(await store.get("key")).toBe("value");
    });
  });

  describe("increment()", () => {
    it("creates the counter at amount if it doesn't exist", async () => {
      const store = new ArrayCacheStore();
      expect(await store.increment("hits")).toBe(1);
    });

    it("increments an existing counter by the given amount", async () => {
      const store = new ArrayCacheStore();
      await store.increment("hits");
      await store.increment("hits");
      expect(await store.increment("hits", 3)).toBe(5);
    });

    it("throws on a non-numeric value rather than concatenating", async () => {
      // `"5" + 1` is `"51"`. Redis's INCRBY rejects a non-integer value
      // outright, so every store agreeing on that is what keeps a bug
      // from being visible only under one CACHE_STORE.
      const store = new ArrayCacheStore();
      await store.put("name", "5");
      await expect(store.increment("name")).rejects.toThrow(/not a number/);
    });
  });

  describe("releaseLock()", () => {
    it("deletes the entry only when the owner matches", async () => {
      const store = new ArrayCacheStore();
      await store.add("job_lock", "owner-a", 30);

      expect(await store.releaseLock("job_lock", "owner-b")).toBe(false);
      expect(await store.get("job_lock")).toBe("owner-a");

      expect(await store.releaseLock("job_lock", "owner-a")).toBe(true);
      expect(await store.get("job_lock")).toBeUndefined();
    });

    it("is false for a lock that never existed", async () => {
      expect(await new ArrayCacheStore().releaseLock("nope_lock", "owner")).toBe(false);
    });
  });

  describe("expiry sweeping", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /**
     * Expiry is otherwise evaluated only on read, so an entry nothing
     * reads again is never reclaimed. `RateLimiter` writes exactly that
     * shape — `throttle:<name>:<ip>` plus a `:timer` sibling per distinct
     * client, never read once the window has passed — which in a
     * long-running server is an unbounded leak paced by how many distinct
     * clients you see.
     */
    it("removes expired entries on a timer, with nothing reading them", async () => {
      const store = new ArrayCacheStore({ sweepIntervalSeconds: 60 });
      await store.put("throttle:1.2.3.4", 1, 10);
      await store.put("throttle:1.2.3.4:timer", 1, 10);
      await store.put("kept", "forever");

      expect(store.size()).toBe(3);

      await vi.advanceTimersByTimeAsync(61_000);

      // No get()/has() ran — the sweep alone reclaimed them.
      expect(store.size()).toBe(1);
      expect(await store.get("kept")).toBe("forever");
    });

    it("prune() reports how many it removed and leaves live entries", async () => {
      const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
      await store.put("dead-a", 1, 10);
      await store.put("dead-b", 2, 10);
      await store.put("live", 3, 600);
      await store.put("forever", 4);

      vi.advanceTimersByTime(11_000);

      expect(store.prune()).toBe(2);
      expect(store.size()).toBe(2);
    });

    it("sweepIntervalSeconds: 0 disables the timer entirely", async () => {
      const store = new ArrayCacheStore({ sweepIntervalSeconds: 0 });
      await store.put("key", "value", 10);

      await vi.advanceTimersByTimeAsync(600_000);

      // Still resident — nothing read it, and nothing swept.
      expect(store.size()).toBe(1);
    });

    it("disconnect() stops the sweep timer", async () => {
      const store = new ArrayCacheStore({ sweepIntervalSeconds: 60 });
      await store.put("key", "value", 10);

      await store.disconnect();
      await vi.advanceTimersByTimeAsync(600_000);

      expect(store.size()).toBe(1);
      // Idempotent — shutdown runs it once, a test may run it again.
      await expect(store.disconnect()).resolves.toBeUndefined();
    });
  });

  describe("add()", () => {
    it("sets the key and returns true when it doesn't already exist", async () => {
      const store = new ArrayCacheStore();
      expect(await store.add("key", "value")).toBe(true);
      expect(await store.get("key")).toBe("value");
    });

    it("returns false and leaves the existing value untouched when the key already exists", async () => {
      const store = new ArrayCacheStore();
      await store.put("key", "original");
      expect(await store.add("key", "new")).toBe(false);
      expect(await store.get("key")).toBe("original");
    });

    it("is atomic across concurrent callers racing on the same key — only one wins", async () => {
      // add()/increment() must not have an `await` between their
      // existence check and their write, or concurrent
      // callers can all observe "absent" before any of them writes —
      // exactly the bug that would make Lock.acquire() non-exclusive.
      const store = new ArrayCacheStore();

      const results = await Promise.all([
        store.add("key", "A"),
        store.add("key", "B"),
        store.add("key", "C"),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("increment() atomicity", () => {
    it("concurrent increments on the same key don't lose updates", async () => {
      const store = new ArrayCacheStore();

      const results = await Promise.all([
        store.increment("hits"),
        store.increment("hits"),
        store.increment("hits"),
      ]);

      expect(results.sort()).toEqual([1, 2, 3]);
      expect(await store.get("hits")).toBe(3);
    });
  });
});
