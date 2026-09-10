import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArrayCacheStore } from "../../src/stores/array-cache-store.js";
import { RateLimiter } from "../../src/rate-limiting/rate-limiter.js";
import { Limit } from "../../src/rate-limiting/limit.js";

function buildLimiter(): RateLimiter {
  return new RateLimiter(new ArrayCacheStore());
}

describe("RateLimiter", () => {
  describe("hit()/attempts()/tooManyAttempts()", () => {
    it("attempts() starts at 0 for an unseen key", async () => {
      const limiter = buildLimiter();
      expect(await limiter.attempts("key")).toBe(0);
    });

    it("hit() increments the attempt count", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      await limiter.hit("key");
      expect(await limiter.attempts("key")).toBe(2);
    });

    it("tooManyAttempts() is false while under the limit", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      expect(await limiter.tooManyAttempts("key", 5)).toBe(false);
    });

    it("tooManyAttempts() is true once the limit is reached", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      await limiter.hit("key");
      expect(await limiter.tooManyAttempts("key", 2)).toBe(true);
    });
  });

  describe("remaining()/retriesLeft()", () => {
    it("remaining() decreases as hits accumulate", async () => {
      const limiter = buildLimiter();
      expect(await limiter.remaining("key", 5)).toBe(5);
      await limiter.hit("key");
      expect(await limiter.remaining("key", 5)).toBe(4);
    });

    it("remaining() floors at 0, never negative", async () => {
      const limiter = buildLimiter();

      for (let i = 0; i < 10; i++) {
        await limiter.hit("key");
      }

      expect(await limiter.remaining("key", 5)).toBe(0);
    });

    it("retriesLeft() is an alias for remaining()", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      expect(await limiter.retriesLeft("key", 5)).toBe(await limiter.remaining("key", 5));
    });
  });

  describe("clear()/resetAttempts()", () => {
    it("resetAttempts() clears the hit counter", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      await limiter.resetAttempts("key");
      expect(await limiter.attempts("key")).toBe(0);
    });

    it("clear() resets both the hit counter and the window timer", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      await limiter.clear("key");

      expect(await limiter.attempts("key")).toBe(0);
      expect(await limiter.availableIn("key")).toBe(0);
    });
  });

  describe("availableIn()", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("is 0 for a key that's never been hit", async () => {
      const limiter = buildLimiter();
      expect(await limiter.availableIn("key")).toBe(0);
    });

    it("reflects seconds remaining until the window resets", async () => {
      vi.setSystemTime(0);
      const limiter = buildLimiter();
      await limiter.hit("key", 60);

      expect(await limiter.availableIn("key")).toBe(60);

      vi.setSystemTime(30_000);
      expect(await limiter.availableIn("key")).toBe(30);

      vi.setSystemTime(60_000);
      expect(await limiter.availableIn("key")).toBe(0);
    });
  });

  describe("window reset behavior", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("tooManyAttempts() resets the counter once the window has elapsed", async () => {
      vi.setSystemTime(0);
      const limiter = buildLimiter();

      await limiter.hit("key", 10);
      await limiter.hit("key", 10);
      expect(await limiter.tooManyAttempts("key", 2)).toBe(true);

      vi.setSystemTime(10_001);
      // Both the counter and its timer key expire via the cache store's own TTL.
      expect(await limiter.tooManyAttempts("key", 2)).toBe(false);
      expect(await limiter.attempts("key")).toBe(0);
    });

    it("pins a finite TTL even when the counter expires between add() and increment()", async () => {
      vi.setSystemTime(0);
      const store = new ArrayCacheStore();

      // Reproduce the immortal-counter race: add() seeds the counter with a
      // TTL and reports it created (added=true), but the entry expires
      // before increment() reads it, so increment() recreates it with no
      // expiry. The old re-seed guard (`!added && ...`) skipped re-pinning
      // exactly this case, leaving the counter — and the lockout — forever.
      const realAdd = store.add.bind(store);
      let raced = false;
      store.add = async (key, value, ttl) => {
        const result = await realAdd(key, value, ttl);

        if (!raced && key === "key") {
          raced = true;
          await store.forget(key); // expire it out from under increment()
        }

        return result;
      };

      const limiter = new RateLimiter(store);
      await limiter.hit("key", 10);

      expect(await limiter.attempts("key")).toBe(1);

      // With the TTL re-pinned, the counter must expire when its window
      // elapses rather than living forever.
      vi.setSystemTime(10_001);
      expect(await limiter.attempts("key")).toBe(0);
    });
  });

  describe("attempt()", () => {
    it("runs the callback and records a hit when under the limit", async () => {
      const limiter = buildLimiter();
      let ran = false;

      const result = await limiter.attempt("key", 5, () => {
        ran = true;

        return "ok";
      });

      expect(ran).toBe(true);
      expect(result).toBe("ok");
      expect(await limiter.attempts("key")).toBe(1);
    });

    it("returns false and skips the callback once the limit is reached", async () => {
      const limiter = buildLimiter();
      await limiter.hit("key");
      await limiter.hit("key");

      let ran = false;
      const result = await limiter.attempt("key", 2, () => {
        ran = true;

        return "ok";
      });

      expect(ran).toBe(false);
      expect(result).toBe(false);
    });

    it("returns true when the callback returns undefined", async () => {
      const limiter = buildLimiter();
      const result = await limiter.attempt("key", 5, () => undefined);
      expect(result).toBe(true);
    });
  });

  describe("for()/limiter() named limiters", () => {
    it("limiter() returns undefined for an unregistered name", () => {
      const limiter = buildLimiter();
      expect(limiter.limiter("missing")).toBeUndefined();
    });

    it("for() registers a callback resolvable via limiter()", async () => {
      const limiter = buildLimiter();
      limiter.for("uploads", () => Limit.perMinute(5).by("user-1"));

      const resolved = limiter.limiter("uploads");
      expect(resolved).toBeDefined();

      const limits = await resolved!();
      expect(limits).toHaveLength(1);
      expect(limits[0]!.maxAttempts).toBe(5);
      expect(limits[0]!.key).toBe("user-1");
    });

    it("passes call-site arguments through to the registered callback", async () => {
      const limiter = buildLimiter();
      limiter.for("per-user", (userId: unknown) => Limit.perMinute(5).by(`user:${userId}`));

      const resolved = limiter.limiter("per-user")!;
      const limits = await resolved(42);

      expect(limits[0]!.key).toBe("user:42");
    });

    it("wraps a single-Limit return value into an array", async () => {
      const limiter = buildLimiter();
      limiter.for("simple", () => Limit.perMinute(10));

      const limits = await limiter.limiter("simple")!();
      expect(limits).toHaveLength(1);
    });

    it("supports multiple stacked limits from one named limiter", async () => {
      const limiter = buildLimiter();
      limiter.for("stacked", () => [Limit.perMinute(10).by("a"), Limit.perDay(1000).by("b")]);

      const limits = await limiter.limiter("stacked")!();
      expect(limits).toHaveLength(2);
      expect(limits[0]!.key).toBe("a");
      expect(limits[1]!.key).toBe("b");
    });

    it("resolves duplicate keys across stacked limits to each limit's fallbackKey()", async () => {
      const limiter = buildLimiter();
      // Two limits with no explicit .by() both default to key "" — a collision.
      const expectedFallbackA = Limit.perMinute(10).fallbackKey();
      const expectedFallbackB = Limit.perDay(1000).fallbackKey();

      limiter.for("duplicate", () => [Limit.perMinute(10), Limit.perDay(1000)]);

      const limits = await limiter.limiter("duplicate")!();
      expect(limits[0]!.key).toBe(expectedFallbackA);
      expect(limits[1]!.key).toBe(expectedFallbackB);
      expect(limits[0]!.key).not.toBe(limits[1]!.key);
    });
  });
});
