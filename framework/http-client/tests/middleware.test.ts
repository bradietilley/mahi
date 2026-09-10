import { afterEach, describe, expect, it } from "vitest";
import { HttpClientFactory } from "../src/http-client-factory.js";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";

afterEach(() => {
  Http.restore();
});

describe("request middleware", () => {
  it("mutations reach the transport", async () => {
    let seen: Request | undefined;
    const http = new PendingRequest().withTransport(async (request) => {
      seen = request;

      return new Response(null, { status: 200 });
    });

    await http
      .withRequestMiddleware((request) => request.withHeader("X-Added", "yes"))
      .get("https://x.test/");

    expect(seen?.headers.get("x-added")).toBe("yes");
  });

  it("can rewrite the URL", async () => {
    let seen: Request | undefined;
    const http = new PendingRequest().withTransport(async (request) => {
      seen = request;

      return new Response(null, { status: 200 });
    });

    await http
      .withRequestMiddleware((request) => request.withUrl("https://rewritten.test/"))
      .get("https://x.test/");

    expect(seen?.url).toBe("https://rewritten.test/");
  });

  it("may be async", async () => {
    let seen: Request | undefined;
    const http = new PendingRequest().withTransport(async (request) => {
      seen = request;

      return new Response(null, { status: 200 });
    });

    await http
      .withRequestMiddleware(async (request) => {
        await Promise.resolve();

        return request.withHeader("X-Async", "1");
      })
      .get("https://x.test/");

    expect(seen?.headers.get("x-async")).toBe("1");
  });
});

describe("response middleware", () => {
  it("can rewrite the response", async () => {
    Http.fake({ "*": { original: true } });

    const response = await Http.withResponseMiddleware(async (original) => {
      const { makeClientResponse } = await import("../src/client-response.js");

      return makeClientResponse(
        new Response(JSON.stringify({ rewritten: true }), {
          status: original.status,
          headers: { "content-type": "application/json" },
        }),
        original.request,
        original.durationMs,
      );
    }).get("https://x.test/");

    expect(response.json("rewritten")).toBe(true);
  });

  it("sees the response on the way back out of a full pipe", async () => {
    Http.fake({ "*": { status: 201 } });

    let observed: number | undefined;
    await Http.withMiddleware(async (request, next) => {
      const response = await next(request);
      observed = response.status;

      return response;
    }).get("https://x.test/");

    expect(observed).toBe(201);
  });
});

describe("ordering", () => {
  it("runs global outermost, per-request inside, transport innermost", async () => {
    const log: string[] = [];
    const factory = new HttpClientFactory();

    factory.withGlobalMiddleware(async (request, next) => {
      log.push("global:down");
      const response = await next(request);
      log.push("global:up");

      return response;
    });
    factory.fake((_request) => {
      log.push("transport");

      return { ok: true };
    });

    await factory
      .request()
      .withMiddleware(async (request, next) => {
        log.push("request:down");
        const response = await next(request);
        log.push("request:up");

        return response;
      })
      .get("https://x.test/");

    expect(log).toEqual(["global:down", "request:down", "transport", "request:up", "global:up"]);
  });

  it("runs multiple per-request middleware in registration order", async () => {
    const log: string[] = [];
    Http.fake();

    await Http.withMiddleware(async (request, next) => {
      log.push("first");

      return next(request);
    })
      .withMiddleware(async (request, next) => {
        log.push("second");

        return next(request);
      })
      .get("https://x.test/");

    expect(log).toEqual(["first", "second"]);
  });
});

describe("short-circuiting", () => {
  it("a middleware that never calls next() stops the transport running", async () => {
    let transportRan = false;
    const http = new PendingRequest().withTransport(async () => {
      transportRan = true;

      return new Response(null, { status: 200 });
    });

    const { makeClientResponse } = await import("../src/client-response.js");
    const response = await http
      .withMiddleware(async (request) =>
        makeClientResponse(new Response("from cache", { status: 200 }), request, 0),
      )
      .get("https://x.test/");

    expect(transportRan).toBe(false);
    expect(response.body()).toBe("from cache");
  });
});

describe("interaction with retries", () => {
  it("re-runs middleware on every attempt", async () => {
    let attempts = 0;
    Http.fake({ "*": Http.sequence().pushStatus(500).pushStatus(500).push({ ok: true }) });

    await Http.withMiddleware(async (request, next) => {
      attempts++;

      return next(request);
    })
      .retry(3)
      .get("https://x.test/");

    expect(attempts).toBe(3);
  });
});

describe("global middleware", () => {
  it("applies to every request the factory creates", async () => {
    const factory = new HttpClientFactory();
    factory.withGlobalMiddleware((request, next) => next(request.withHeader("X-Global", "1")));

    let seen: string | undefined;
    factory.fake((request) => {
      seen = request.header("x-global");

      return { ok: true };
    });

    await factory.request().get("https://x.test/a");
    expect(seen).toBe("1");

    seen = undefined;
    await factory.request().get("https://x.test/b");
    expect(seen).toBe("1");
  });
});
