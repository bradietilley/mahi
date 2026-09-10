import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { Signer, SIGNER_TOKEN } from "@mahi/encryption";
import { Request } from "../src/request.js";
import { Router } from "../src/router.js";
import { HttpResponse } from "../src/response.js";
import { createErrorHandler, ErrorRendererRegistry } from "../src/middleware/error-handler.js";
import { signedUrl, hasValidSignature, validateSignature } from "../src/signed-url.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

function makeSigner(): Signer {
  return new Signer(KEY);
}

function installApp(signer = makeSigner()): Signer {
  const app = new Application();
  app.instance(SIGNER_TOKEN, signer);
  setCurrentApp(app);

  return signer;
}

/** Turn a signed URL string into a Request as the router would see it. */
function requestFor(url: string): Request {
  const [path, query = ""] = url.split("?");

  return Request.create(
    path!,
    "GET",
    {},
    { query: Object.fromEntries(new URLSearchParams(query)) },
  );
}

describe("signedUrl / hasValidSignature", () => {
  beforeEach(() => installApp());
  afterEach(() => clearCurrentApp());

  it("produces a URL that verifies against the same signer", () => {
    const url = signedUrl("/verify-email", { id: "42" });
    expect(url).toContain("signature=");
    expect(hasValidSignature(requestFor(url))).toBe(true);
  });

  it("rejects a request with no signature", () => {
    expect(hasValidSignature(requestFor("/verify-email?id=42"))).toBe(false);
  });

  it("rejects a tampered param", () => {
    const url = signedUrl("/verify-email", { id: "42" });
    const tampered = url.replace("id=42", "id=99");
    expect(hasValidSignature(requestFor(tampered))).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const url = signedUrl("/verify-email", { id: "42" });
    const tampered = `${url}x`;
    expect(hasValidSignature(requestFor(tampered))).toBe(false);
  });

  it("is order-independent between signing and verifying params", () => {
    const url = signedUrl("/x", { a: "1", b: "2" });
    // Reorder the query params; signature must still verify.
    const [path, query = ""] = url.split("?");
    const params = Object.fromEntries(new URLSearchParams(query));
    const reordered = new URLSearchParams();

    for (const key of Object.keys(params).reverse()) {
      reordered.set(key, params[key]!);
    }

    const req = Request.create(path!, "GET", {}, { query: Object.fromEntries(reordered) });
    expect(hasValidSignature(req)).toBe(true);
  });

  it("honours expiry: valid before, invalid after", () => {
    const url = signedUrl("/reset", { id: "1" }, { expiresInSeconds: 100, now: 1000 });
    expect(hasValidSignature(requestFor(url), { now: 1099 })).toBe(true);
    expect(hasValidSignature(requestFor(url), { now: 1101 })).toBe(false);
  });

  it("a signer with a different key rejects the signature", () => {
    const url = signedUrl("/verify-email", { id: "42" });
    const other = new Signer(Buffer.from("ffffffffffffffffffffffffffffffff"));
    expect(hasValidSignature(requestFor(url), { signer: other })).toBe(false);
  });
});

describe("validateSignature() middleware", () => {
  beforeEach(() => installApp());
  afterEach(() => clearCurrentApp());

  function build() {
    const app = new Application();
    app.instance(SIGNER_TOKEN, makeSigner());
    const hono = new Hono();
    hono.onError(createErrorHandler(app, new ErrorRendererRegistry()));

    return { hono, router: new Router(hono) };
  }

  it("allows a validly signed request through", async () => {
    const { hono, router } = build();
    router.get("/verify", () => HttpResponse.json({ ok: true })).middleware(validateSignature());

    const url = signedUrl("/verify", { id: "7" });
    const res = await hono.request(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("403s an unsigned request", async () => {
    const { hono, router } = build();
    router.get("/verify", () => HttpResponse.json({ ok: true })).middleware(validateSignature());

    const res = await hono.request("/verify?id=7");
    expect(res.status).toBe(403);
  });

  it("403s an expired request", async () => {
    const { hono, router } = build();
    router
      .get("/verify", () => HttpResponse.json({ ok: true }))
      .middleware(validateSignature({ now: 5000 }));

    const url = signedUrl("/verify", { id: "7" }, { expiresInSeconds: 10, now: 1000 });
    const res = await hono.request(url);
    expect(res.status).toBe(403);
  });
});
