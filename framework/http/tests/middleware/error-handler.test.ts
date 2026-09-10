import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { HttpError } from "../../src/http-error.js";
import { createErrorHandler, ErrorRendererRegistry } from "../../src/middleware/error-handler.js";

function appThatThrows(error: unknown, environment?: string): Hono {
  const app = new Application();

  if (environment) {
    app.useEnvironment(environment);
  }

  const hono = new Hono();
  hono.onError(createErrorHandler(app, new ErrorRendererRegistry()));
  hono.get("/boom", () => {
    throw error;
  });

  return hono;
}

describe("error handler — HttpError headers", () => {
  it("applies an HttpError's headers to the response", async () => {
    const res = await appThatThrows(
      HttpError.unauthorized().withHeaders({ "WWW-Authenticate": 'Bearer realm="api"' }),
    ).request("/boom");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="api"');
    expect(await res.json()).toEqual({ message: "Unauthorized", details: undefined });
  });

  it("emits Allow on a 405 thrown from a handler", async () => {
    const res = await appThatThrows(HttpError.methodNotAllowed(["GET", "POST"])).request("/boom");

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("emits Retry-After on a 429", async () => {
    const res = await appThatThrows(HttpError.tooManyRequests("Slow down", 30)).request("/boom");
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

describe("error handler — Hono HTTPException", () => {
  it("maps it into the JSON envelope rather than a generic 500", async () => {
    // `bodyLimit()` raises this as a 413. Without the mapping, an
    // oversize request was reported to the client as our bug (500) and
    // logged as an unhandled error every time.
    const res = await appThatThrows(
      new HTTPException(413, { message: "Payload Too Large" }),
    ).request("/boom");

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ message: "Payload Too Large" });
  });

  it("falls back to a status-derived message when the exception has none", async () => {
    const res = await appThatThrows(new HTTPException(413)).request("/boom");
    expect(await res.json()).toEqual({ message: "Payload Too Large" });
  });
});

describe("error handler — debug messages by environment", () => {
  it("hides the real message in production", async () => {
    const res = await appThatThrows(new Error("kysely constraint violation"), "production").request(
      "/boom",
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "Internal Server Error" });
  });

  it("shows it in local", async () => {
    const res = await appThatThrows(new Error("boom"), "local").request("/boom");
    expect(await res.json()).toEqual({ message: "boom" });
  });

  it("shows it in development too", async () => {
    // The scaffolded `config/env.ts` constrains NODE_ENV to
    // development|test|production and `Application` seeds the
    // environment from it — so a strict `=== "local"` check meant the
    // local-DX branch was unreachable in every app this framework
    // generates.
    const res = await appThatThrows(new Error("boom"), "development").request("/boom");
    expect(await res.json()).toEqual({ message: "boom" });
  });

  it("hides it in test, which is not a developer-facing environment", async () => {
    const res = await appThatThrows(new Error("boom"), "test").request("/boom");
    expect(await res.json()).toEqual({ message: "Internal Server Error" });
  });
});
