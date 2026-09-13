import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Router, translatePath } from "../src/router.js";
import { HttpResponse } from "../src/response.js";
import { RouteRegistry } from "../src/route-registry.js";

describe("Router", () => {
  it("registers get/post/put/patch/delete handlers on the underlying Hono instance", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    router.get("/ping", () => HttpResponse.json({ ok: true }));
    router.post("/echo", async (request) => HttpResponse.json(request.input()));

    const getRes = await hono.request("/ping");
    expect(await getRes.json()).toEqual({ ok: true });

    const postRes = await hono.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hi: "there" }),
    });
    expect(await postRes.json()).toEqual({ hi: "there" });
  });

  it("group() mounts a sub-router under a base path", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    router.group("/todos", (todos) => {
      todos.get("/", () => HttpResponse.json({ list: true }));
      todos.get("/{id}", (request) => HttpResponse.json({ id: request.route("id") }));
    });

    const listRes = await hono.request("/todos");
    expect(await listRes.json()).toEqual({ list: true });

    const itemRes = await hono.request("/todos/42");
    expect(await itemRes.json()).toEqual({ id: "42" });
  });

  it("use() registers pipes for a given path", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    const seen: string[] = [];

    router.use("/protected/*", async (request, next) => {
      seen.push("middleware");

      return next(request);
    });
    router.get("/protected/thing", () => HttpResponse.json({ ok: true }));

    await hono.request("/protected/thing");

    expect(seen).toEqual(["middleware"]);
  });

  it("get(path, handler).middleware() runs route pipes", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    const seen: string[] = [];

    router
      .get("/things", () => {
        seen.push("handler");

        return HttpResponse.json({ ok: true });
      })
      .middleware(async (request, next) => {
        seen.push("pipe");

        return next(request);
      });

    await hono.request("/things");
    expect(seen).toEqual(["pipe", "handler"]);
  });

  /**
   * Group middleware is `hono.use("*")`, and Hono only matches a `use()`
   * handler against routes registered *after* it. Declaring
   * `middleware()` at the bottom of a `group()` callback therefore
   * guards nothing, and the failure mode is a silently unguarded
   * endpoint, not an error. These two tests pin the ordering
   * requirement documented on `Router.middleware()`.
   */
  it("group middleware() applies to routes registered after it", async () => {
    const hono = new Hono();
    const seen: string[] = [];

    new Router(hono).group("/admin", (admin) => {
      admin.middleware(async (request, next) => {
        seen.push("pipe");

        return next(request);
      });
      admin.get("/users", () => HttpResponse.json({ ok: true }));
    });

    await hono.request("/admin/users");
    expect(seen).toEqual(["pipe"]);
  });

  it("throws when middleware() is called after routes, rather than silently guarding nothing", () => {
    const hono = new Hono();

    // Hono only matches `use("*")` against routes registered afterwards,
    // so this ordering would leave `/admin/users` unguarded. Silently
    // doing so is how an `authenticate()` pipe ends up protecting
    // nothing, so it's a hard error.
    expect(() =>
      new Router(hono).group("/admin", (admin) => {
        admin.get("/users", () => HttpResponse.json({ ok: true }));
        admin.middleware(async (request, next) => next(request));
      }),
    ).toThrow(/called after routes were registered/);
  });

  it("still allows a path-scoped use() after routes. That has no ordering trap", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    router.get("/open", () => HttpResponse.json({ ok: true }));

    expect(() => router.use("/other/*", async (request, next) => next(request))).not.toThrow();
  });
});

describe("param syntax", () => {
  it("translates {param} to Hono :param and matches it", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    router.get("/posts/{post}", (request) => HttpResponse.json({ post: request.route("post") }));

    const res = await hono.request("/posts/7");
    expect(await res.json()).toEqual({ post: "7" });
  });

  it("translates optional {param?}", () => {
    expect(translatePath("/files/{path?}")).toBe("/files/:path?");
    expect(translatePath("/posts/{post}")).toBe("/posts/:post");
  });

  it("rejects raw :param syntax", () => {
    expect(() => translatePath("/posts/:id")).toThrow(/uses ":param" syntax/);
    const router = new Router(new Hono());
    expect(() => router.get("/posts/:id", () => HttpResponse.json({}))).toThrow(/uses ":param"/);
  });
});

describe("HTTP verbs", () => {
  it("registers options/head/query/any/match", async () => {
    const hono = new Hono();
    const router = new Router(hono);

    router.options("/thing", () => HttpResponse.json({ verb: "options" }));
    router.query("/search", () => HttpResponse.json({ verb: "query" }));
    router.any("/any", () => HttpResponse.json({ verb: "any" }));
    router.match(["PUT", "PATCH"], "/matched", () => HttpResponse.json({ verb: "matched" }));

    expect(await (await hono.request("/thing", { method: "OPTIONS" })).json()).toEqual({
      verb: "options",
    });
    expect(await (await hono.request("/search", { method: "QUERY" })).json()).toEqual({
      verb: "query",
    });
    expect(await (await hono.request("/any", { method: "DELETE" })).json()).toEqual({
      verb: "any",
    });
    expect(await (await hono.request("/matched", { method: "PUT" })).json()).toEqual({
      verb: "matched",
    });
    expect(await (await hono.request("/matched", { method: "PATCH" })).json()).toEqual({
      verb: "matched",
    });
    expect((await hono.request("/matched", { method: "GET" })).status).toBe(404);
  });
});

describe("named routes", () => {
  it("records the full {param} path into the shared registry", () => {
    const registry = new RouteRegistry();
    const hono = new Hono();
    const router = new Router(hono, registry);

    router.get("/posts/{post}", () => HttpResponse.json({})).name("posts.show");
    router.group("/users", (users) => {
      users.get("/{username}/posts", () => HttpResponse.json({})).name("users.posts");
    });

    expect(registry.get("posts.show")).toEqual({ methods: ["GET"], path: "/posts/{post}" });
    expect(registry.get("users.posts")).toEqual({
      methods: ["GET"],
      path: "/users/{username}/posts",
    });
  });

  it("throws on a duplicate route name", () => {
    const registry = new RouteRegistry();
    const router = new Router(new Hono(), registry);
    router.get("/a", () => HttpResponse.json({})).name("dup");
    expect(() => router.get("/b", () => HttpResponse.json({})).name("dup")).toThrow(
      /already registered/,
    );
  });
});

describe("request.parameter()", () => {
  it("returns the param value when present", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    router.get("/items/{id}", (request) => HttpResponse.json({ id: request.parameter("id") }));

    const res = await hono.request("/items/abc");
    expect(await res.json()).toEqual({ id: "abc" });
  });

  it("throws when the param is missing", async () => {
    const hono = new Hono();
    const router = new Router(hono);
    router.get("/items", (request) => HttpResponse.json({ id: request.parameter("id") }));

    const res = await hono.request("/items");
    expect(res.status).toBe(500);
  });
});
