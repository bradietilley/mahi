import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { RateLimiter, Limit, ArrayCacheStore, RATE_LIMITER_TOKEN } from "@mahiframework/cache";
import { HttpResponse } from "../../src/response.js";
import { Router } from "../../src/router.js";
import { throttle } from "../../src/middleware/throttle.js";

function installApp(): RateLimiter {
  const app = new Application();
  const limiter = new RateLimiter(new ArrayCacheStore());
  app.instance(RATE_LIMITER_TOKEN, limiter);
  setCurrentApp(app);

  return limiter;
}

function build() {
  const hono = new Hono();
  const router = new Router(hono);

  return { hono, router };
}

describe("throttle(): inline form", () => {
  beforeEach(() => installApp());
  afterEach(() => clearCurrentApp());

  it("allows requests within the limit, with decreasing X-RateLimit-Remaining", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle({ max: 2, windowSeconds: 60 }));

    const first = await hono.request("/things");
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("1");

    const second = await hono.request("/things");
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns 429 with a Retry-After header once the limit is exceeded", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle({ max: 2, windowSeconds: 60 }));

    await hono.request("/things");
    await hono.request("/things");
    const third = await hono.request("/things");

    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    expect(await third.json()).toEqual({ message: "Too Many Requests" });
  });

  it("holds the limit under a burst of concurrent requests (no read-then-write race)", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle({ max: 5, windowSeconds: 60 }));

    // Fire the requests concurrently. With the old read-then-hit sequence
    // every request could observe "under the limit" before any incremented,
    // letting far more than `max` through. Incrementing atomically first
    // means exactly `max` succeed and the rest are 429.
    const results = await Promise.all(Array.from({ length: 20 }, () => hono.request("/things")));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;

    expect(ok).toBe(5);
    expect(limited).toBe(15);
  });

  it("cannot be bypassed by forging x-forwarded-for", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle({ max: 2, windowSeconds: 60 }));

    // Three requests from one client, each claiming a different origin
    // address. Before `ip()` stopped trusting the header, every one of
    // these got its own bucket and the limiter was decorative: an
    // attacker had unlimited login attempts for the price of an
    // incrementing string.
    await hono.request("/things", { headers: { "x-forwarded-for": "1.1.1.1" } });
    await hono.request("/things", { headers: { "x-forwarded-for": "2.2.2.2" } });
    const third = await hono.request("/things", { headers: { "x-forwarded-for": "3.3.3.3" } });

    expect(third.status).toBe(429);
  });

  it("keys on the route PATTERN, so rotating an id doesn't multiply the quota", async () => {
    const { hono, router } = build();
    router
      .get("/posts/{post}", () => HttpResponse.json({ ok: true }))
      .middleware(throttle({ max: 2, windowSeconds: 60 }));

    // Distinct concrete paths, one route. Keying on the concrete path
    // gave `/posts/1` and `/posts/2` separate buckets, so any enumerable
    // id turned an N/minute limit into N-per-id/minute.
    await hono.request("/posts/1");
    await hono.request("/posts/2");
    const third = await hono.request("/posts/3");

    expect(third.status).toBe(429);
  });

  it("keeps separate buckets per route", async () => {
    const { hono, router } = build();
    const limit = throttle({ max: 1, windowSeconds: 60 });
    router.get("/things", () => HttpResponse.json({ ok: true })).middleware(limit);
    router.get("/others", () => HttpResponse.json({ ok: true })).middleware(limit);

    await hono.request("/things");
    expect((await hono.request("/things")).status).toBe(429);
    expect((await hono.request("/others")).status).toBe(200);
  });

  it("tracks different keys independently via a custom key()", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(
        throttle({ max: 2, windowSeconds: 60, key: (request) => request.query("user") ?? "anon" }),
      );

    await hono.request("/things?user=alice");
    await hono.request("/things?user=alice");
    expect((await hono.request("/things?user=alice")).status).toBe(429);

    expect((await hono.request("/things?user=bob")).status).toBe(200);
  });

  it("supports a custom key() resolver", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(
        throttle({ max: 1, windowSeconds: 60, key: (request) => request.query("user") ?? "anon" }),
      );

    await hono.request("/things?user=alice");
    const aliceSecond = await hono.request("/things?user=alice");
    expect(aliceSecond.status).toBe(429);

    const bob = await hono.request("/things?user=bob");
    expect(bob.status).toBe(200);
  });
});

describe("throttle(): named limiter form", () => {
  beforeEach(() => installApp());
  afterEach(() => clearCurrentApp());

  it("throws a clear error when the named limiter isn't registered", async () => {
    const hono = new Hono();
    hono.onError((err) => {
      throw err;
    });
    const router = new Router(hono);
    router.get("/things", () => HttpResponse.json({ ok: true })).middleware(throttle("missing"));

    await expect(hono.request("/things")).rejects.toThrow(/Rate limiter "missing" is not defined/);
  });

  it("resolves a registered named limiter and enforces it", async () => {
    const limiter = installApp();
    limiter.for("uploads", () => Limit.perMinute(2));

    const { hono, router } = build();
    router.get("/uploads", () => HttpResponse.json({ ok: true })).middleware(throttle("uploads"));

    await hono.request("/uploads");
    await hono.request("/uploads");
    const third = await hono.request("/uploads");

    expect(third.status).toBe(429);
  });

  it("passes the Request through to the named limiter callback", async () => {
    const limiter = installApp();
    limiter.for("per-user", (request: { query: (key: string) => string | undefined }) =>
      Limit.perMinute(1).by(request.query("user") ?? "anon"),
    );

    const { hono, router } = build();
    router.get("/things", () => HttpResponse.json({ ok: true })).middleware(throttle("per-user"));

    await hono.request("/things?user=alice");
    const aliceSecond = await hono.request("/things?user=alice");
    expect(aliceSecond.status).toBe(429);

    const bob = await hono.request("/things?user=bob");
    expect(bob.status).toBe(200);
  });

  it("enforces multiple stacked limits from a single named limiter (all must pass)", async () => {
    const limiter = installApp();
    limiter.for("stacked", () => [Limit.perMinute(10), Limit.perDay(2)]);

    const { hono, router } = build();
    router.get("/things", () => HttpResponse.json({ ok: true })).middleware(throttle("stacked"));

    await hono.request("/things");
    await hono.request("/things");
    const third = await hono.request("/things");

    expect(third.status).toBe(429);
  });

  it("Limit.none() (Unlimited) skips rate limiting entirely", async () => {
    const limiter = installApp();
    limiter.for("unrestricted", () => Limit.none());

    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle("unrestricted"));

    for (let i = 0; i < 50; i++) {
      const res = await hono.request("/things");
      expect(res.status).toBe(200);
    }
  });

  it("calls a limit's custom response() callback instead of throwing the default 429", async () => {
    const limiter = installApp();
    limiter.for("custom-response", () =>
      Limit.perMinute(1).response(() => HttpResponse.json({ custom: "slow down" }, 429)),
    );

    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(throttle("custom-response"));

    await hono.request("/things");
    const second = await hono.request("/things");

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ custom: "slow down" });
  });

  it("an afterCallback-gated limit only records a hit when the callback returns true", async () => {
    const limiter = installApp();
    limiter.for("only-failures", () => Limit.perMinute(1).after((res: any) => res.status === 400));

    const { hono, router } = build();
    router
      .get("/things", (request) => {
        const fail = request.query("fail") === "true";

        return HttpResponse.json({ ok: !fail }, fail ? 400 : 200);
      })
      .middleware(throttle("only-failures"));

    const ok1 = await hono.request("/things");
    const ok2 = await hono.request("/things");
    expect(ok1.status).toBe(200);
    expect(ok2.status).toBe(200);

    await hono.request("/things?fail=true");
    const limited = await hono.request("/things");
    expect(limited.status).toBe(429);
  });
});
