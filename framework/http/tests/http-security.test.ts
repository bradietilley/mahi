import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import type { Router } from "../src/router.js";
import { HttpKernel } from "../src/http-kernel.js";
import { HttpResponse } from "../src/response.js";
import { Request } from "../src/request.js";

/** A kernel with a couple of routes, and whatever `http` config is given. */
function kernelWith(
  config: Record<string, unknown> = {},
  register?: (router: Router) => void,
): HttpKernel {
  class Provider {
    routes(router: Router) {
      router.get("/things", () => HttpResponse.json({ ok: true }));
      router.post("/things", () => HttpResponse.json({ created: true }, 201));
      router.get("/posts/{post}", (request) => HttpResponse.json({ post: request.route("post") }));
      register?.(router);
    }
  }

  const app = new Application();

  if (Object.keys(config).length > 0) {
    app.config.set("http", config);
  }

  (app as unknown as { providers: unknown[] }).providers = [new Provider()];

  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();

  return kernel;
}

describe("404 / 405 in the JSON envelope", () => {
  it("answers an unknown route with a JSON 404, not Hono's plain text", async () => {
    const res = await kernelWith().raw().request("/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ message: "Not Found" });
  });

  it("answers a method mismatch with 405 + Allow, not 404", async () => {
    // Hono reports an existing path with the wrong method as a 404, so a
    // client calling DELETE on a GET/POST route was told the endpoint
    // does not exist and went looking for a deployment problem.
    const res = await kernelWith().raw().request("/things", { method: "DELETE" });

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ message: "Method Not Allowed" });

    const allow = res.headers.get("Allow")!.split(", ").sort();
    expect(allow).toEqual(["GET", "HEAD", "POST"]);
  });

  it("resolves Allow through route params", async () => {
    const res = await kernelWith().raw().request("/posts/42", { method: "PUT" });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")!.split(", ").sort()).toEqual(["GET", "HEAD"]);
  });

  it("does not turn an unknown path into a 405", async () => {
    expect((await kernelWith().raw().request("/nope", { method: "POST" })).status).toBe(404);
  });

  it("serves HEAD on a GET-only route rather than calling it disallowed", async () => {
    expect((await kernelWith().raw().request("/things", { method: "HEAD" })).status).toBe(200);
  });
});

describe("security headers", () => {
  it("sets conservative defaults on a normal response", async () => {
    const res = await kernelWith().raw().request("/things");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets them on error responses too, including the 404", async () => {
    const res = await kernelWith().raw().request("/nope");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("omits HSTS over plain HTTP", async () => {
    // The header is a commitment. Emitting one from a deployment that
    // isn't actually reachable over TLS is how a staging box locks
    // itself out for six months.
    const res = await kernelWith().raw().request("/things");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("sets HSTS when the request is secure", async () => {
    const res = await kernelWith().raw().request("https://example.com/things");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=15552000; includeSubDomains",
    );
  });

  it("honours overrides and extra headers", async () => {
    const kernel = kernelWith({
      securityHeaders: {
        frameOptions: false,
        referrerPolicy: "same-origin",
        extra: { "X-Robots-Tag": "noindex" },
      },
    });
    const res = await kernel.raw().request("/things");

    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("installs nothing when disabled", async () => {
    const res = await kernelWith({ securityHeaders: { enabled: false } })
      .raw()
      .request("/things");
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
  });

  it("does not clobber a header the handler set deliberately", async () => {
    const kernel = kernelWith({}, (router) => {
      router.get("/framed", () =>
        HttpResponse.json({ ok: true }).header("X-Frame-Options", "SAMEORIGIN"),
      );
    });

    const res = await kernel.raw().request("/framed");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("request body limit", () => {
  function postJson(kernel: HttpKernel, bytes: number): Promise<Response> {
    const body = JSON.stringify({ blob: "x".repeat(bytes) });

    return Promise.resolve(
      kernel.raw().request("/things", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
  }

  it("accepts a body under the limit", async () => {
    expect((await postJson(kernelWith(), 1000)).status).toBe(201);
  });

  it("rejects an oversize body with a 413 in the JSON envelope", async () => {
    // The limit must apply before the body is parsed into memory, and
    // for every request — including ones for paths that do not exist —
    // not only once validation runs.
    const res = await postJson(kernelWith({ bodyLimit: { maxBytes: 2048 } }), 8192);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "Payload Too Large" });
  });

  it("defaults to 1 MiB for JSON", async () => {
    expect((await postJson(kernelWith(), 2 * 1024 * 1024)).status).toBe(413);
  });

  it("gives multipart its own, larger ceiling", async () => {
    const kernel = kernelWith({ bodyLimit: { maxBytes: 1024, maxMultipartBytes: 1024 * 1024 } });

    const form = new FormData();
    form.set("file", new File(["x".repeat(64 * 1024)], "big.bin"));

    // Well over the 1 KiB JSON limit; well under the multipart one.
    // Applying the JSON limit to uploads would break them at 1 MiB.
    const res = await kernel.raw().request("/things", { method: "POST", body: form });
    expect(res.status).toBe(201);
  });

  it("can be disabled entirely", async () => {
    const kernel = kernelWith({ bodyLimit: { maxBytes: 0, maxMultipartBytes: 0 } });
    expect((await postJson(kernel, 2 * 1024 * 1024)).status).toBe(201);
  });

  it("rejects before the route handler runs", async () => {
    let handlerRan = false;
    const kernel = kernelWith({ bodyLimit: { maxBytes: 512 } }, (router) => {
      router.post("/sink", () => {
        handlerRan = true;

        return HttpResponse.json({});
      });
    });

    const res = await kernel.raw().request("/sink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(4096) }),
    });

    expect(res.status).toBe(413);
    expect(handlerRan).toBe(false);
  });
});

describe("nested query and form parsing through the kernel", () => {
  it("gives a route handler a real array for ?ids[]=", async () => {
    const kernel = kernelWith({}, (router) => {
      router.get("/search", (request) => HttpResponse.json({ ids: request.input("ids") }));
    });

    const res = await kernel.raw().request("/search?ids[]=1&ids[]=2");
    expect(await res.json()).toEqual({ ids: ["1", "2"] });
  });

  it("expands nested object notation in a urlencoded form body", async () => {
    const kernel = kernelWith({}, (router) => {
      router.post("/form", (request) => HttpResponse.json({ user: request.input("user") }));
    });

    const res = await kernel.raw().request("/form", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "user[name]=bob&user[role]=admin",
    });

    expect(await res.json()).toEqual({ user: { name: "bob", role: "admin" } });
  });

  it("round-trips a nested query back into fullUrl()", () => {
    // The bag is nested internally; fullUrl() has to flatten it back to
    // bracket notation or the URL a request reports isn't the one it
    // received.
    const request = Request.create("/search?ids[]=1&ids[]=2", "GET");

    expect(request.query()).toEqual({ ids: ["1", "2"] });
    expect(request.fullUrl()).toBe("http://localhost/search?ids%5B%5D=1&ids%5B%5D=2");
    // queryString() stays raw, which is what signature verification needs.
    expect(request.queryString()).toBe("ids%5B%5D=1&ids%5B%5D=2");
  });
});

describe("routePattern()", () => {
  it("reports the matched pattern in {param} form, not the concrete path", async () => {
    let seen: string | undefined;
    const kernel = kernelWith({}, (router) => {
      router.get("/orders/{order}/items/{item}", (request) => {
        seen = request.routePattern();

        return HttpResponse.json({});
      });
    });

    await kernel.raw().request("/orders/9/items/3");
    expect(seen).toBe("/orders/{order}/items/{item}");
  });
});
