import { describe, expect, it } from "vitest";
import { ClientRequest, type FetchBody } from "../src/client-request.js";
import { makeClientResponse, type ClientResponse } from "../src/client-response.js";
import { RequestFailedError } from "../src/errors.js";

const request = new ClientRequest({
  method: "GET",
  url: "https://x.test/thing",
  headers: new Headers(),
});

/** A `ClientResponse` over a synthesised platform `Response`. */
function respond(body: FetchBody | null = null, init: ResponseInit = {}): Promise<ClientResponse> {
  return makeClientResponse(new Response(body, init), request, 5);
}

describe("status predicates", () => {
  it("successful() covers 200-299 at its boundaries", async () => {
    // 199 is not tested: the platform `Response` constructor rejects any
    // status below 200, so a 1xx can never reach a `ClientResponse`.
    expect((await respond(null, { status: 200 })).successful()).toBe(true);
    expect((await respond(null, { status: 299 })).successful()).toBe(true);
    expect((await respond(null, { status: 300 })).successful()).toBe(false);
  });

  it("redirect() covers 300-399 at its boundaries", async () => {
    expect((await respond(null, { status: 299 })).redirect()).toBe(false);
    expect((await respond(null, { status: 300 })).redirect()).toBe(true);
    expect((await respond(null, { status: 399 })).redirect()).toBe(true);
    expect((await respond(null, { status: 400 })).redirect()).toBe(false);
  });

  it("clientError() covers 400-499 at its boundaries", async () => {
    expect((await respond(null, { status: 399 })).clientError()).toBe(false);
    expect((await respond(null, { status: 400 })).clientError()).toBe(true);
    expect((await respond(null, { status: 499 })).clientError()).toBe(true);
    expect((await respond(null, { status: 500 })).clientError()).toBe(false);
  });

  it("serverError() covers 500+", async () => {
    expect((await respond(null, { status: 499 })).serverError()).toBe(false);
    expect((await respond(null, { status: 500 })).serverError()).toBe(true);
    expect((await respond(null, { status: 599 })).serverError()).toBe(true);
  });

  it("failed() is true for 4xx and 5xx but not for a redirect", async () => {
    expect((await respond(null, { status: 200 })).failed()).toBe(false);
    expect((await respond(null, { status: 301 })).failed()).toBe(false);
    expect((await respond(null, { status: 404 })).failed()).toBe(true);
    expect((await respond(null, { status: 500 })).failed()).toBe(true);
  });

  it("exposes the named status checks", async () => {
    expect((await respond(null, { status: 200 })).ok()).toBe(true);
    expect((await respond(null, { status: 201 })).created()).toBe(true);
    expect((await respond(null, { status: 401 })).unauthorized()).toBe(true);
    expect((await respond(null, { status: 403 })).forbidden()).toBe(true);
    expect((await respond(null, { status: 404 })).notFound()).toBe(true);
    expect((await respond(null, { status: 422 })).unprocessable()).toBe(true);
    expect((await respond(null, { status: 429 })).tooManyRequests()).toBe(true);
  });

  it("noContent() requires both a 204 and an empty body", async () => {
    expect((await respond(null, { status: 204 })).noContent()).toBe(true);
    expect((await respond(null, { status: 200 })).noContent()).toBe(false);
    expect((await respond("body", { status: 200 })).noContent()).toBe(false);

    // The body half of the check only fires for a malformed response the
    // `Response` constructor won't build (it rejects a body with a 204),
    // so it is exercised by forcing the buffer directly.
    const malformed = await makeClientResponse(new Response(null, { status: 204 }), request, 1, {
      buffered: new TextEncoder().encode("oops"),
    });
    expect(malformed.noContent()).toBe(false);
  });
});

describe("body access", () => {
  it("body() is synchronous and repeatable", async () => {
    const response = await respond("hello");
    expect(response.body()).toBe("hello");
    // A platform Response body is single-use; buffering is what makes the
    // second read work at all.
    expect(response.body()).toBe("hello");
  });

  it("json() parses and memoises", async () => {
    const response = await respond('{"a":{"b":[1,2]}}');
    const first = response.json();
    expect(first).toEqual({ a: { b: [1, 2] } });
    expect(response.json()).toBe(first);
  });

  it("json(key) does a dot-path lookup with a fallback", async () => {
    const response = await respond('{"user":{"name":"Ada","tags":["math"]}}');
    expect(response.json("user.name")).toBe("Ada");
    expect(response.json("user.tags.0")).toBe("math");
    expect(response.json("user.missing", "default")).toBe("default");
  });

  it("json() throws on invalid JSON, quoting the body", async () => {
    const response = await respond("<html>not json</html>");
    expect(() => response.json()).toThrow(/not valid JSON/);
    expect(() => response.json()).toThrow(/<html>not json<\/html>/);
  });

  it("collect() wraps a JSON array in a Collection", async () => {
    const response = await respond('{"items":[1,2,3]}');
    expect(response.collect<number>("items").sum()).toBe(6);
  });

  it("bytes() returns the raw body bytes", async () => {
    const response = await respond("abc");
    expect(Array.from(response.bytes())).toEqual([97, 98, 99]);
  });

  it("stream() throws on a buffered response, pointing at the fix", async () => {
    const response = await respond("abc");
    expect(() => response.stream()).toThrow(/buffered/);
  });
});

describe("headers and cookies", () => {
  it("header() returns a string or undefined, never an array", async () => {
    const response = await respond(null, { headers: { "X-A": "1" } });
    expect(response.header("x-a")).toBe("1");
    expect(response.header("x-missing")).toBeUndefined();
  });

  it("headers() returns every header as a record", async () => {
    const response = await respond(null, { headers: { "X-A": "1", "X-B": "2" } });
    expect(response.headers()["x-a"]).toBe("1");
    expect(response.headers()["x-b"]).toBe("2");
  });

  it("cookies() parses multiple Set-Cookie headers", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    const response = await makeClientResponse(new Response(null, { headers }), request, 1);

    // getSetCookie() is the only correct read, headers.get() comma-joins
    // them, which is ambiguous with the comma inside an Expires date.
    expect(response.cookies()).toEqual({ session: "abc", theme: "dark" });
  });

  it("cookies() is empty when none were set", async () => {
    expect((await respond()).cookies()).toEqual({});
  });
});

describe("failure handling", () => {
  it("throw() is a no-op on success and returns this", async () => {
    const response = await respond('{"a":1}', { status: 200 });
    expect(response.throw()).toBe(response);
    // The chaining this enables is the point.
    expect(response.throw().json("a")).toBe(1);
  });

  it("throw() raises RequestFailedError on a failure, with the body in the message", async () => {
    const response = await respond('{"errors":{"name":"required"}}', { status: 422 });
    expect(() => response.throw()).toThrow(RequestFailedError);
    expect(() => response.throw()).toThrow(/status code 422/);
    expect(() => response.throw()).toThrow(/required/);
  });

  it("throw(callback) runs the callback before raising", async () => {
    const response = await respond("nope", { status: 500 });
    let seen: number | undefined;
    expect(() => response.throw((r) => (seen = r.status))).toThrow(RequestFailedError);
    expect(seen).toBe(500);
  });

  it("throwIf/throwUnless respect their condition", async () => {
    const failure = await respond("x", { status: 500 });
    expect(() => failure.throwIf(true)).toThrow(RequestFailedError);
    expect(failure.throwIf(false)).toBe(failure);
    expect(() => failure.throwUnless(false)).toThrow(RequestFailedError);
    expect(failure.throwUnless(true)).toBe(failure);
  });

  it("throwIf accepts a predicate over the response", async () => {
    const response = await respond("x", { status: 503 });
    expect(() => response.throwIf((r) => r.status === 503)).toThrow(RequestFailedError);
    expect(response.throwIf((r) => r.status === 500)).toBe(response);
  });

  it("throwIfStatus fires even on a successful status", async () => {
    const response = await respond("x", { status: 200 });
    // Unconditional by design, matching Laravel, narrowing it to failures
    // would make it useless for "this status is unexpected here".
    expect(() => response.throwIfStatus(200)).toThrow(RequestFailedError);
  });

  it("throwIfStatus accepts a predicate over the status", async () => {
    const response = await respond("x", { status: 418 });
    expect(() => response.throwIfStatus((s) => s > 400)).toThrow(RequestFailedError);
    expect(response.throwIfStatus((s) => s > 500)).toBe(response);
  });

  it("throwUnlessStatus raises when the status does not match", async () => {
    const response = await respond("x", { status: 500 });
    expect(() => response.throwUnlessStatus(200)).toThrow(RequestFailedError);
    expect((await respond("x", { status: 200 })).throwUnlessStatus(200).status).toBe(200);
  });

  it("onError runs on failure and never throws", async () => {
    const failure = await respond("x", { status: 500 });
    let called = 0;
    expect(failure.onError(() => called++)).toBe(failure);
    expect(called).toBe(1);

    const success = await respond("x", { status: 200 });
    success.onError(() => called++);
    expect(called).toBe(1);
  });

  it("toException() is undefined on 2xx and an error on failure", async () => {
    expect((await respond("x", { status: 200 })).toException()).toBeUndefined();
    expect((await respond("x", { status: 404 })).toException()).toBeInstanceOf(RequestFailedError);
  });

  it("truncates a long body in the exception message", async () => {
    const response = await respond("x".repeat(500), { status: 500 });
    const message = response.toException()!.message;
    expect(message).toContain("...");
    expect(message.length).toBeLessThan(300);
  });
});

describe("metadata", () => {
  it("exposes status, durationMs, and the originating request", async () => {
    const response = await respond("x", { status: 201 });
    expect(response.status).toBe(201);
    expect(response.durationMs).toBe(5);
    expect(response.request).toBe(request);
  });

  it("falls back to the requested URL when the Response has none", async () => {
    // A synthesised (stubbed) Response has an empty `url`; the caller
    // means "the URL I asked for" by `response.url`.
    expect((await respond("x")).url).toBe("https://x.test/thing");
  });

  it("toWebResponse returns the underlying platform Response", async () => {
    const raw = new Response("x", { status: 200 });
    const response = await makeClientResponse(raw, request, 1);
    expect(response.toWebResponse()).toBe(raw);
  });
});
