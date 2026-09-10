import { afterEach, describe, expect, it } from "vitest";
import type { ClientResponse } from "../src/client-response.js";
import { Http } from "../src/http.js";

afterEach(() => {
  Http.restore();
});

// Thin: the mechanics live in @mahi/core's `pooled()` and are tested in
// framework/core/tests/pooled.test.ts. What matters here is the wiring.

describe("Http.pool", () => {
  it("preserves record keys", async () => {
    Http.fake({
      "x.test/user": { name: "Ada" },
      "x.test/repos": [{ id: 1 }],
    });

    const results = await Http.pool((http) => ({
      user: () => http.get("https://x.test/user"),
      repos: () => http.get("https://x.test/repos"),
    }));

    expect((results.user as ClientResponse).json("name")).toBe("Ada");
    expect((results.repos as ClientResponse).json()).toEqual([{ id: 1 }]);
  });

  it("preserves array position", async () => {
    Http.fake({ "*": { ok: true } });

    const results = await Http.pool((http) => [
      () => http.get("https://x.test/a"),
      () => http.get("https://x.test/b"),
    ]);

    expect(results).toHaveLength(2);
    expect((results[0] as ClientResponse).url).toBe("https://x.test/a");
    expect((results[1] as ClientResponse).url).toBe("https://x.test/b");
  });

  it("surfaces a per-entry failure as an Error without failing the pool", async () => {
    Http.fake({
      "x.test/good": { ok: true },
      "x.test/bad": Http.failedConnection("down"),
    });

    const results = await Http.pool((http) => ({
      good: () => http.get("https://x.test/good"),
      bad: () => http.get("https://x.test/bad"),
    }));

    expect((results.good as ClientResponse).json("ok")).toBe(true);
    expect(results.bad).toBeInstanceOf(Error);
    expect((results.bad as Error).message).toMatch(/down/);
  });

  it("does not reject when an entry throws a StrayRequestError", async () => {
    Http.fake({ "x.test/good": { ok: true } });

    const results = await Http.pool((http) => ({
      good: () => http.get("https://x.test/good"),
      stray: () => http.get("https://unmatched.test/"),
    }));

    expect((results.good as ClientResponse).status).toBe(200);
    expect((results.stray as Error).name).toBe("StrayRequestError");
  });

  it("threads concurrency through", async () => {
    let inFlight = 0;
    let peak = 0;

    Http.fake(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;

      return { ok: true };
    });

    await Http.pool(
      (http) => [
        () => http.get("https://x.test/a"),
        () => http.get("https://x.test/b"),
        () => http.get("https://x.test/c"),
        () => http.get("https://x.test/d"),
      ],
      { concurrency: 2 },
    );

    expect(peak).toBe(2);
  });

  it("carries the factory's configuration into pooled requests", async () => {
    Http.fake({ "*": { ok: true } });

    await Http.pool((http) => ({
      user: () => http.baseUrl("https://x.test").withToken("t").get("/user"),
    }));

    Http.assertSent((request) => request.header("authorization") === "Bearer t");
    Http.assertSent("x.test/user");
  });

  it("records every pooled request", async () => {
    Http.fake({ "*": { ok: true } });

    await Http.pool((http) => [
      () => http.get("https://x.test/a"),
      () => http.get("https://x.test/b"),
    ]);

    Http.assertSentCount(2);
  });
});
