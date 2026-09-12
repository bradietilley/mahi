import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http-error.js";

describe("HttpError", () => {
  it("carries the status, message and details it was constructed with", () => {
    const error = new HttpError(418, "I'm a teapot", { brewing: false });
    expect(error.status).toBe(418);
    expect(error.message).toBe("I'm a teapot");
    expect(error.details).toEqual({ brewing: false });
    expect(error).toBeInstanceOf(Error);
  });

  it.each([
    ["notFound", HttpError.notFound(), 404, "Not Found"],
    ["badRequest", HttpError.badRequest(), 400, "Bad Request"],
    ["unauthorized", HttpError.unauthorized(), 401, "Unauthorized"],
    ["forbidden", HttpError.forbidden(), 403, "Forbidden"],
    ["payloadTooLarge", HttpError.payloadTooLarge(), 413, "Payload Too Large"],
    ["tooManyRequests", HttpError.tooManyRequests(), 429, "Too Many Requests"],
  ])("%s() defaults to %i", (_name, error, status, message) => {
    expect(error.status).toBe(status);
    expect(error.message).toBe(message);
  });

  it("carries no headers by default", () => {
    expect(HttpError.notFound().headers).toEqual({});
  });

  it("withHeaders() merges, with the later call winning", () => {
    const error = HttpError.unauthorized()
      .withHeaders({ "WWW-Authenticate": 'Bearer realm="api"' })
      .withHeaders({ "X-Trace": "abc" });

    expect(error.headers).toEqual({
      "WWW-Authenticate": 'Bearer realm="api"',
      "X-Trace": "abc",
    });
  });

  it("methodNotAllowed() requires and sets Allow", () => {
    // `Allow` is mandatory on a 405 (RFC 9110 §15.5.6) — it is the only
    // way the client learns what it should have sent — so it's a
    // required parameter rather than an optional extra.
    const error = HttpError.methodNotAllowed(["GET", "HEAD"]);
    expect(error.status).toBe(405);
    expect(error.headers.Allow).toBe("GET, HEAD");
  });

  it("tooManyRequests() sets Retry-After only when given one", () => {
    expect(HttpError.tooManyRequests().headers["Retry-After"]).toBeUndefined();
    expect(HttpError.tooManyRequests("Slow down", 30).headers["Retry-After"]).toBe("30");
  });

  it("allows overriding the default message", () => {
    expect(HttpError.unauthorized("Token expired").message).toBe("Token expired");
    expect(HttpError.unauthorized("Token expired").status).toBe(401);
  });

  it("distinguishes unauthorized (401) from forbidden (403)", () => {
    // Not a tautology worth deleting: conflating these is the single most
    // common auth-status mistake, and the distinction matters for
    // clients deciding whether to prompt for re-authentication.
    expect(HttpError.unauthorized().status).not.toBe(HttpError.forbidden().status);
  });
});
