import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { HttpResponse } from "../src/response.js";
import { Request } from "../src/request.js";
import { toHonoMiddleware, type HttpPipe } from "../src/middleware/pipeline-middleware.js";
import { expiredCookie, parseCookies, serializeCookie, withCookies } from "../src/cookies.js";

describe("serializeCookie", () => {
  it("percent-encodes the value so arbitrary payloads survive", () => {
    expect(serializeCookie("t", "a b;c=d")).toContain("t=a%20b%3Bc%3Dd");
  });

  it("defaults Path to / and adds nothing else", () => {
    expect(serializeCookie("t", "v")).toBe("t=v; Path=/");
  });

  it("emits every attribute it is given", () => {
    const cookie = serializeCookie("t", "v", {
      maxAge: 60,
      domain: "example.com",
      path: "/app",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      priority: "high",
    });

    expect(cookie).toContain("Max-Age=60");
    expect(cookie).toContain("Domain=example.com");
    expect(cookie).toContain("Path=/app");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Priority=High");
  });

  describe("prefixes", () => {
    it("__Host- forces Secure and Path=/ and drops Domain", () => {
      const cookie = serializeCookie("s", "v", {
        prefix: "host",
        domain: "example.com",
        path: "/nested",
        secure: false,
      });

      expect(cookie).toMatch(/^__Host-s=/);
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Domain=");
    });

    it("__Secure- forces Secure", () => {
      expect(serializeCookie("s", "v", { prefix: "secure", secure: false })).toMatch(
        /^__Secure-s=.*Secure/,
      );
    });
  });

  describe("rejects what a browser would silently discard", () => {
    it("a Max-Age beyond the 400-day cap", () => {
      // Browsers clamp it; failing loudly beats a session that
      // mysteriously ends early.
      expect(() => serializeCookie("t", "v", { maxAge: 401 * 24 * 60 * 60 })).toThrow(/400 days/);
    });

    it("an invalid cookie name", () => {
      expect(() => serializeCookie("bad name", "v")).toThrow(/Invalid cookie name/);
    });

    it("attribute values carrying a separator or newline", () => {
      // Otherwise a caller-supplied path could append attributes of its
      // own, or split the header entirely.
      expect(() => serializeCookie("t", "v", { path: "/a; Domain=evil.com" })).toThrow(/";"/);
    });

    it("Partitioned without Secure", () => {
      expect(() => serializeCookie("t", "v", { partitioned: true })).toThrow(/Secure/);
    });
  });
});

describe("parseCookies", () => {
  it("decodes values and splits on ;", () => {
    expect(parseCookies("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("returns {} for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("skips malformed pairs instead of throwing", () => {
    // A junk cookie from some unrelated tool must not 500 the request.
    expect(parseCookies("garbage; a=1")).toEqual({ a: "1" });
  });

  it("keeps the FIRST of a duplicated name", () => {
    // Browsers do the same. Taking the last would let a Domain-scoped
    // cookie from a sibling subdomain shadow the host's own.
    expect(parseCookies("a=host; a=sibling")).toEqual({ a: "host" });
  });

  it("survives a value that isn't valid percent-encoding", () => {
    expect(parseCookies("a=100%")).toEqual({ a: "100%" });
  });
});

describe("expiredCookie", () => {
  it("expires in both ways browsers understand", () => {
    const cookie = expiredCookie("s", { path: "/app" });
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
    // Path must match the original or the browser keeps the real cookie.
    expect(cookie).toContain("Path=/app");
  });
});

describe("withCookies", () => {
  it("appends without collapsing multiple Set-Cookie headers", () => {
    // `Headers.set()` — and copying a Headers bag entry by entry — joins
    // them into one value no browser will parse.
    const response = withCookies(HttpResponse.json({}).toWeb(), ["a=1", "b=2"]);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("preserves cookies already on the response", () => {
    const original = HttpResponse.json({}).cookie("first", "1").toWeb();
    const response = withCookies(original, ["second=2; Path=/"]);

    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("returns the same response when there is nothing to add", () => {
    const original = HttpResponse.json({}).toWeb();
    expect(withCookies(original, [])).toBe(original);
  });
});

describe("cookies through the framework boundary", () => {
  // Mahi handlers return platform `Response` objects, and Hono only
  // merges its own queued headers into responses it built itself — so
  // cookies must survive that boundary explicitly.

  function mount(register: (router: Router) => void, pipes: HttpPipe[] = []): Hono {
    const hono = new Hono();

    if (pipes.length > 0) {
      hono.use("*", toHonoMiddleware(pipes));
    }

    register(new Router(hono));

    return hono;
  }

  it("writes a cookie queued on the request by the handler", async () => {
    const hono = mount((router) => {
      router.get("/", (request) => {
        request.queueCookie("session", "abc", { httpOnly: true, maxAge: 60 });

        return HttpResponse.json({ ok: true });
      });
    });

    const response = await hono.request("/");
    expect(response.headers.get("set-cookie")).toBe("session=abc; Max-Age=60; Path=/; HttpOnly");
  });

  it("writes a cookie queued by a PIPE, not the handler", async () => {
    // The session-guard shape: something upstream of the handler decides
    // to set a cookie, and the handler returns its own response knowing
    // nothing about it.
    const hono = mount(
      (router) => router.get("/", () => HttpResponse.json({ ok: true })),
      [
        (request, next) => {
          request.queueCookie("from-pipe", "1");

          return next(request);
        },
      ],
    );

    expect((await hono.request("/")).headers.get("set-cookie")).toContain("from-pipe=1");
  });

  it("writes a cookie queued before a short-circuiting pipe's own response", async () => {
    // A 401 that still needs to clear a stale session cookie.
    const hono = mount(
      (router) => router.get("/", () => HttpResponse.json({ ok: true })),
      [
        async (request) => {
          request.queueCookieForget("session");

          return HttpResponse.json({ error: "nope" }, 401);
        },
      ],
    );

    const response = await hono.request("/");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("emits a cookie ONCE even with global middleware wrapping the route", async () => {
    // The boundary runs once per pipeline frame — the route handler, then
    // every enclosing global middleware on the way back out. Reading the
    // queue non-destructively made each frame re-emit it, so a real
    // browser login received two identical Set-Cookie headers. Caught by
    // curl against a live server, not by any single-frame test.
    const hono = mount(
      (router) =>
        router.get("/", (request) => {
          request.queueCookie("session", "abc");

          return HttpResponse.json({ ok: true });
        }),
      [(request, next) => next(request)],
    );

    expect((await hono.request("/")).headers.getSetCookie()).toEqual(["session=abc; Path=/"]);
  });

  it("still writes a cookie queued by a pipe AFTER next() returns", async () => {
    // The mirror of the de-duplication above: clearing the queue must not
    // drop a cookie queued on the way back out.
    const hono = mount(
      (router) => router.get("/", () => HttpResponse.json({ ok: true })),
      [
        async (request, next) => {
          const response = await next(request);
          request.queueCookie("after", "1");

          return response;
        },
      ],
    );

    expect((await hono.request("/")).headers.get("set-cookie")).toContain("after=1");
  });

  it("emits one Set-Cookie per cookie", async () => {
    const hono = mount((router) => {
      router.get("/", (request) => {
        request.queueCookie("a", "1").queueCookie("b", "2");

        return HttpResponse.json({});
      });
    });

    expect((await hono.request("/")).headers.getSetCookie()).toHaveLength(2);
  });

  it("re-queuing the same cookie replaces it rather than emitting two", async () => {
    // A guard that re-issues a sliding session must not send two
    // contradictory values for one cookie.
    const hono = mount((router) => {
      router.get("/", (request) => {
        request.queueCookie("session", "old").queueCookie("session", "new");

        return HttpResponse.json({});
      });
    });

    const cookies = (await hono.request("/")).headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("session=new");
  });

  it("treats the same name on a different path as a different cookie", async () => {
    const hono = mount((router) => {
      router.get("/", (request) => {
        request.queueCookie("s", "1", { path: "/a" }).queueCookie("s", "2", { path: "/b" });

        return HttpResponse.json({});
      });
    });

    expect((await hono.request("/")).headers.getSetCookie()).toHaveLength(2);
  });

  it("keeps cookies set directly on the response alongside queued ones", async () => {
    const hono = mount((router) => {
      router.get("/", (request) => {
        request.queueCookie("queued", "1");

        return HttpResponse.json({}).cookie("direct", "2");
      });
    });

    const cookies = (await hono.request("/")).headers.getSetCookie();
    expect(cookies.join("|")).toContain("queued=1");
    expect(cookies.join("|")).toContain("direct=2");
  });

  it("survives the request being upgraded to a typed subclass", async () => {
    // `fromExisting()` swaps the Request instance mid-flight for a
    // controller's typed one; a cookie queued before that must not be
    // lost with the old object.
    class TypedRequest extends Request {}

    const hono = mount(
      (router) =>
        router.get("/", (request) => {
          const upgraded = TypedRequest.fromExisting(request);
          upgraded.queueCookie("late", "1");

          return HttpResponse.json({});
        }),
      [
        (request, next) => {
          request.queueCookie("early", "1");

          return next(request);
        },
      ],
    );

    const cookies = (await hono.request("/")).headers.getSetCookie().join("|");
    expect(cookies).toContain("early=1");
    expect(cookies).toContain("late=1");
  });

  it("reads inbound cookies off the request", async () => {
    const hono = mount((router) =>
      router.get("/", (request) =>
        HttpResponse.json({ one: request.cookie("one"), all: request.cookies() }),
      ),
    );

    const response = await hono.request("/", { headers: { Cookie: "one=1; two=2" } });
    await expect(response.json()).resolves.toEqual({ one: "1", all: { one: "1", two: "2" } });
  });

  it("reads a prefixed cookie under its prefixed name", async () => {
    const hono = mount((router) =>
      router.get("/", (request) => HttpResponse.json({ s: request.cookie("s", "host") })),
    );

    const response = await hono.request("/", { headers: { Cookie: "__Host-s=v" } });
    await expect(response.json()).resolves.toEqual({ s: "v" });
  });

  describe("headers queued on the Hono context by third-party middleware", () => {
    // Hono only applies these when IT builds the response. Mahi handlers
    // return platform Responses, so the boundary has to merge them
    // explicitly or `hono/cors` (which HttpKernel mounts) silently stops
    // working on every framework route.

    it("preserves a header set with c.header() before next()", async () => {
      const hono = new Hono();
      hono.use("*", async (c, next) => {
        c.header("x-queued", "1");
        await next();
      });
      new Router(hono).get("/", () => HttpResponse.json({ ok: true }));

      expect((await hono.request("/")).headers.get("x-queued")).toBe("1");
    });

    it("preserves a cookie set through hono/cookie", async () => {
      const hono = new Hono();
      hono.use("*", async (c, next) => {
        setCookie(c, "hono", "1");
        await next();
      });
      new Router(hono).get("/", () => HttpResponse.json({ ok: true }));

      expect((await hono.request("/")).headers.get("set-cookie")).toContain("hono=1");
    });

    it("keeps both Hono's cookie and the framework's", async () => {
      const hono = new Hono();
      hono.use("*", async (c, next) => {
        setCookie(c, "hono", "1");
        await next();
      });
      new Router(hono).get("/", (request) => {
        request.queueCookie("mahi", "2");

        return HttpResponse.json({ ok: true });
      });

      const cookies = (await hono.request("/")).headers.getSetCookie().join("|");
      expect(cookies).toContain("hono=1");
      expect(cookies).toContain("mahi=2");
    });

    it("does not let a queued header override the handler's own", async () => {
      const hono = new Hono();
      hono.use("*", async (c, next) => {
        c.header("x-both", "queued");
        await next();
      });
      new Router(hono).get("/", () => HttpResponse.json({}).header("x-both", "handler"));

      expect((await hono.request("/")).headers.get("x-both")).toBe("handler");
    });

    it("keeps hono/cors working on framework routes", async () => {
      const hono = new Hono();
      hono.use("*", cors({ origin: "https://app.example.com" }));
      new Router(hono).get("/", () => HttpResponse.json({ ok: true }));

      const response = await hono.request("/", {
        headers: { Origin: "https://app.example.com" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    });
  });

  it("preserves status and body while adding cookies", async () => {
    const hono = mount((router) =>
      router.get("/", (request) => {
        request.queueCookie("a", "1");

        return HttpResponse.json({ created: true }, 201);
      }),
    );

    const response = await hono.request("/");
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ created: true });
  });

  it("adds cookies to a redirect without disturbing Location", async () => {
    const hono = mount((router) =>
      router.get("/", (request) => {
        request.queueCookie("a", "1");

        return HttpResponse.redirect("/next");
      }),
    );

    const response = await hono.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/next");
    expect(response.headers.get("set-cookie")).toContain("a=1");
  });
});

describe("HttpResponse cookie helpers", () => {
  it("cookie() appends rather than replacing", async () => {
    const response = HttpResponse.json({}).cookie("a", "1").cookie("b", "2").toWeb();
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("forgetCookie() writes an expiry", () => {
    const response = HttpResponse.json({}).forgetCookie("a").toWeb();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("JsonResponse.toWeb() keeps cookies and other headers apart", () => {
    // Its header merge used `set()` for everything, which collapsed
    // several cookies into one malformed value.
    const response = HttpResponse.json({})
      .cookie("a", "1")
      .cookie("b", "2")
      .header("x-custom", "y")
      .toWeb();

    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get("x-custom")).toBe("y");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
