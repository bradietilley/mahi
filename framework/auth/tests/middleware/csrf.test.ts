import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { SIGNER_TOKEN, Signer } from "@mahiframework/encryption";
import { HttpError, HttpResponse, Router, toHonoMiddleware } from "@mahiframework/http";
import { csrf, type CsrfOptions } from "../../src/middleware/csrf.js";

function tokenFrom(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  const match = header ? /XSRF-TOKEN=([^;]*)/.exec(header) : null;
  const value = match?.[1];

  return value ? decodeURIComponent(value) : null;
}

describe("csrf middleware", () => {
  let hono: Hono;

  beforeEach(() => {
    hono = new Hono();
    hono.onError((error) => {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }

      return Response.json({ error: String(error) }, { status: 500 });
    });

    hono.use("*", toHonoMiddleware([csrf({ secure: false })]));
    const router = new Router(hono);
    router.get("/", () => HttpResponse.json({ ok: true }));
    router.post("/", () => HttpResponse.json({ ok: true }));
    router.delete("/", () => HttpResponse.json({ ok: true }));
    hono.on(["HEAD", "OPTIONS"], "/", (c) => c.json({ ok: true }));
  });

  it("issues a token cookie on a first request", async () => {
    const response = await hono.request("/");
    expect(tokenFrom(response)).toBeTruthy();
  });

  it("sets the cookie readable by JS", async () => {
    const response = await hono.request("/");
    expect(response.headers.get("set-cookie")).not.toMatch(/HttpOnly/i);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("allows %s without a token", async (method) => {
    const response = await hono.request("/", { method });
    expect(response.status).toBe(200);
  });

  it("rejects an unsafe request with no header", async () => {
    const response = await hono.request("/", { method: "POST" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "CSRF token mismatch." });
  });

  it("rejects an unsafe request whose header doesn't match the cookie", async () => {
    const first = await hono.request("/");
    const token = tokenFrom(first)!;

    const response = await hono.request("/", {
      method: "POST",
      headers: { Cookie: `XSRF-TOKEN=${token}`, "X-XSRF-TOKEN": "different" },
    });

    expect(response.status).toBe(403);
  });

  it("allows an unsafe request whose header matches the cookie", async () => {
    const first = await hono.request("/");
    const token = tokenFrom(first)!;

    const response = await hono.request("/", {
      method: "POST",
      headers: { Cookie: `XSRF-TOKEN=${token}`, "X-XSRF-TOKEN": token },
    });

    expect(response.status).toBe(200);
  });

  it("protects every unsafe method, not just POST", async () => {
    const response = await hono.request("/", { method: "DELETE" });
    expect(response.status).toBe(403);
  });

  it("honours custom cookie and header names", async () => {
    const custom = new Hono();
    custom.onError((error) =>
      Response.json(
        { error: String(error) },
        { status: error instanceof HttpError ? error.status : 500 },
      ),
    );
    custom.use("*", toHonoMiddleware([csrf({ secure: false, cookie: "csrf", header: "X-CSRF" })]));
    const router = new Router(custom);
    router.post("/", () => HttpResponse.json({ ok: true }));
    router.get("/", () => HttpResponse.json({ ok: true }));

    const first = await custom.request("/");
    const token = /csrf=([^;]*)/.exec(first.headers.get("set-cookie") ?? "")?.[1];

    const response = await custom.request("/", {
      method: "POST",
      headers: { Cookie: `csrf=${token}`, "X-CSRF": decodeURIComponent(token!) },
    });

    expect(response.status).toBe(200);
  });

  describe("form-field fallback", () => {
    // A client with no JavaScript cannot set a request header at all, so
    // a header-only check silently limits the app to fetch/XHR callers.
    function formApp(options: CsrfOptions = {}): Hono {
      const app = new Hono();
      app.onError((error) =>
        Response.json(
          { error: String(error) },
          { status: error instanceof HttpError ? error.status : 500 },
        ),
      );
      app.use("*", toHonoMiddleware([csrf({ secure: false, ...options })]));
      const router = new Router(app);
      router.get("/", () => HttpResponse.json({ ok: true }));
      router.post("/", () => HttpResponse.json({ ok: true }));

      return app;
    }

    it("accepts the token from a form field when no header is sent", async () => {
      const app = formApp();
      const token = tokenFrom(await app.request("/"))!;

      const response = await app.request("/", {
        method: "POST",
        headers: {
          Cookie: `XSRF-TOKEN=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _token: token }).toString(),
      });

      expect(response.status).toBe(200);
    });

    it("rejects a form post carrying the wrong field value", async () => {
      const app = formApp();
      const token = tokenFrom(await app.request("/"))!;

      const response = await app.request("/", {
        method: "POST",
        headers: {
          Cookie: `XSRF-TOKEN=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _token: "nope" }).toString(),
      });

      expect(response.status).toBe(403);
    });

    it("can be restricted to the header only", async () => {
      const app = formApp({ field: null });
      const token = tokenFrom(await app.request("/"))!;

      const response = await app.request("/", {
        method: "POST",
        headers: {
          Cookie: `XSRF-TOKEN=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _token: token }).toString(),
      });

      expect(response.status).toBe(403);
    });
  });

  describe("signed cookies", () => {
    // Unsigned double-submit accepts ANY value present in both the cookie
    // and the header — so an attacker who can write a cookie (XSS on a
    // sibling subdomain, MITM on plain HTTP) picks both halves and
    // forges freely. Signing means only tokens this server minted count.
    let app: Application;

    beforeEach(() => {
      app = new Application();
      app.instance(SIGNER_TOKEN, new Signer(Buffer.alloc(32, 9)));
      setCurrentApp(app);
    });

    afterEach(() => clearCurrentApp());

    function signedApp(): Hono {
      const instance = new Hono();
      instance.onError((error) =>
        Response.json(
          { error: String(error) },
          { status: error instanceof HttpError ? error.status : 500 },
        ),
      );
      instance.use("*", toHonoMiddleware([csrf({ secure: false })]));
      const router = new Router(instance);
      router.get("/", () => HttpResponse.json({ ok: true }));
      router.post("/", () => HttpResponse.json({ ok: true }));

      return instance;
    }

    it("signs the issued cookie", async () => {
      const cookie = tokenFrom(await signedApp().request("/"))!;
      // `<token>.<hmac>` — the signature is the part a forger can't produce.
      expect(cookie).toMatch(/^[\w-]+\.[\w-]+$/);
    });

    it("accepts the unwrapped token echoed back in the header", async () => {
      const instance = signedApp();
      const cookie = tokenFrom(await instance.request("/"))!;
      const token = cookie.slice(0, cookie.lastIndexOf("."));

      const response = await instance.request("/", {
        method: "POST",
        headers: { Cookie: `XSRF-TOKEN=${cookie}`, "X-XSRF-TOKEN": token },
      });

      expect(response.status).toBe(200);
    });

    it("rejects a self-consistent cookie the server never issued", async () => {
      // The attack unsigned double-submit is open to: attacker writes
      // `XSRF-TOKEN=forged` and echoes `forged` in the header.
      const response = await signedApp().request("/", {
        method: "POST",
        headers: { Cookie: "XSRF-TOKEN=forged", "X-XSRF-TOKEN": "forged" },
      });

      expect(response.status).toBe(403);
    });

    it("rejects a cookie signed with a different key", async () => {
      const instance = signedApp();
      const foreign = new Signer(Buffer.alloc(32, 1)).sign("attacker-token");

      const response = await instance.request("/", {
        method: "POST",
        headers: { Cookie: `XSRF-TOKEN=${foreign}`, "X-XSRF-TOKEN": "attacker-token" },
      });

      expect(response.status).toBe(403);
    });

    it("re-issues rather than 403s when a safe request presents a junk cookie", async () => {
      // A user with a stale/tampered cookie should get a working form
      // back, not a wall of forbidden responses.
      const response = await signedApp().request("/", { headers: { Cookie: "XSRF-TOKEN=junk" } });

      expect(response.status).toBe(200);
      expect(tokenFrom(response)).toMatch(/^[\w-]+\.[\w-]+$/);
    });

    it("fails loudly when sign: true is asked for without a Signer", async () => {
      clearCurrentApp();
      setCurrentApp(new Application());

      const instance = new Hono();
      instance.onError((error) => Response.json({ error: String(error) }, { status: 500 }));
      instance.use("*", toHonoMiddleware([csrf({ secure: false, sign: true })]));
      new Router(instance).get("/", () => HttpResponse.json({ ok: true }));

      const response = await instance.request("/");
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("SIGNER_TOKEN is not bound"),
      });
    });
  });

  it("supports the __Host- prefix", async () => {
    // `__Host-` is the one thing that stops a compromised sibling
    // subdomain writing the victim's CSRF cookie.
    const app = new Hono();
    app.use("*", toHonoMiddleware([csrf({ prefix: "host", secure: true })]));
    new Router(app).get("/", () => HttpResponse.json({ ok: true }));

    const header = (await app.request("/")).headers.get("set-cookie")!;

    expect(header).toMatch(/^__Host-XSRF-TOKEN=/);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Path=\//i);
    expect(header).not.toMatch(/Domain=/i);
  });

  it("defaults a secure cookie to the __Host- prefix, closing the sibling-subdomain write hole", async () => {
    const app = new Hono();
    app.use("*", toHonoMiddleware([csrf()])); // no options: secure defaults true
    new Router(app).get("/", () => HttpResponse.json({ ok: true }));

    const header = (await app.request("/")).headers.get("set-cookie")!;
    expect(header).toMatch(/^__Host-XSRF-TOKEN=/);
    expect(header).toMatch(/Secure/i);
  });

  it("falls back to __Secure- when a domain is set (which __Host- forbids)", async () => {
    const app = new Hono();
    app.use("*", toHonoMiddleware([csrf({ domain: "app.example.com" })]));
    new Router(app).get("/", () => HttpResponse.json({ ok: true }));

    const header = (await app.request("/")).headers.get("set-cookie")!;
    expect(header).toMatch(/^__Secure-XSRF-TOKEN=/);
    expect(header).toMatch(/Domain=app\.example\.com/i);
  });

  it("uses no prefix on plain HTTP (secure: false) for local development", async () => {
    const app = new Hono();
    app.use("*", toHonoMiddleware([csrf({ secure: false })]));
    new Router(app).get("/", () => HttpResponse.json({ ok: true }));

    const header = (await app.request("/")).headers.get("set-cookie")!;
    expect(header).toMatch(/^XSRF-TOKEN=/);
    expect(header).not.toMatch(/__Host-|__Secure-/);
  });

  it("verifies the default __Host- cookie it issued on a later unsafe request", async () => {
    const app = new Hono();
    app.use("*", toHonoMiddleware([csrf()]));
    const router = new Router(app);
    router.get("/", () => HttpResponse.json({ ok: true }));
    router.post("/", () => HttpResponse.json({ ok: true }));

    const issued = (await app.request("/")).headers.get("set-cookie")!;
    const token = /__Host-XSRF-TOKEN=([^;]*)/.exec(issued)?.[1];
    expect(token).toBeTruthy();

    // Echo the cookie back under its real (__Host- prefixed) name and the
    // decoded value in the header — the round trip must pass.
    const decoded = decodeURIComponent(token!);
    const ok = await app.request("/", {
      method: "POST",
      headers: { Cookie: `__Host-XSRF-TOKEN=${token}`, "X-XSRF-TOKEN": decoded },
    });
    expect(ok.status).toBe(200);
  });
});
