import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { TestClient } from "../src/test-client.js";

/**
 * `TestClient` only needs a `request()`-shaped function — proved here
 * against a trivial in-memory Hono app, no real `Application` required.
 */
function makeClient(): TestClient {
  const hono = new Hono();

  hono.get("/widgets", (c) => c.json([{ id: 1 }]));
  hono.post("/widgets", async (c) => {
    const body = await c.req.json();

    return c.json({ id: 2, ...body }, 201);
  });
  hono.patch("/widgets/:id", async (c) => {
    const body = await c.req.json();

    return c.json({ id: c.req.param("id"), ...body });
  });
  hono.put("/widgets/:id", async (c) => {
    const body = await c.req.json();

    return c.json({ id: c.req.param("id"), ...body });
  });
  hono.delete("/widgets/:id", (c) => c.json({ deleted: c.req.param("id") }));
  hono.get("/echo-headers", (c) => c.json({ auth: c.req.header("Authorization") ?? null }));
  hono.get("/echo-cookie", (c) => c.json({ session: c.req.header("Cookie") ?? null }));
  hono.post("/login", (c) => {
    c.header("Set-Cookie", "session=abc123; Path=/; HttpOnly");

    return c.json({ ok: true });
  });
  hono.get("/no-content", (c) => c.body(null, 204));
  hono.get("/not-found-text", (c) => c.text("nope", 404));

  return new TestClient((path, init) => hono.request(path, init));
}

describe("TestClient", () => {
  it("getJson() returns status + parsed body", async () => {
    const client = makeClient();
    const { status, body } = await client.getJson<{ id: number }[]>("/widgets");
    expect(status).toBe(200);
    expect(body).toEqual([{ id: 1 }]);
  });

  it("postJson() sends a JSON-stringified body with Content-Type: application/json", async () => {
    const client = makeClient();
    const { status, body } = await client.postJson<{ id: number; name: string }>("/widgets", {
      name: "Sprocket",
    });
    expect(status).toBe(201);
    expect(body).toEqual({ id: 2, name: "Sprocket" });
  });

  it("patchJson() and putJson() mirror postJson()", async () => {
    const client = makeClient();
    const patched = await client.patchJson<{ id: string; done: boolean }>("/widgets/1", {
      done: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ id: "1", done: true });

    const put = await client.putJson<{ id: string; name: string }>("/widgets/1", {
      name: "Renamed",
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ id: "1", name: "Renamed" });
  });

  it("deleteJson() sends a DELETE request and parses the JSON response", async () => {
    const client = makeClient();
    const { status, body } = await client.deleteJson<{ deleted: string }>("/widgets/1");
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: "1" });
  });

  it("merges extra init (e.g. custom headers) without dropping Content-Type", async () => {
    const client = makeClient();
    const { body } = await client.getJson<{ auth: string | null }>("/echo-headers", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(body.auth).toBe("Bearer test-token");
  });

  it("defaults the JSON payload to {} when none is given", async () => {
    const client = makeClient();
    const { body } = await client.postJson<{ id: number }>("/widgets");
    expect(body).toEqual({ id: 2 });
  });

  it("normalises a Headers instance passed as init.headers (F4)", async () => {
    const client = makeClient();
    const { body } = await client.getJson<{ auth: string | null }>("/echo-headers", {
      headers: new Headers({ Authorization: "Bearer via-headers" }),
    });
    expect(body.auth).toBe("Bearer via-headers");
  });

  it("normalises a tuple-array passed as init.headers (F4)", async () => {
    const client = makeClient();
    const { body } = await client.getJson<{ auth: string | null }>("/echo-headers", {
      headers: [["Authorization", "Bearer via-tuple"]],
    });
    expect(body.auth).toBe("Bearer via-tuple");
  });

  it("withToken() applies an Authorization header to every request", async () => {
    const client = makeClient().withToken("tok-1");
    const { body } = await client.getJson<{ auth: string | null }>("/echo-headers");
    expect(body.auth).toBe("Bearer tok-1");
  });

  it("captures a Set-Cookie and replays it on the next request (F2)", async () => {
    const client = makeClient();
    await client.postJson("/login");
    expect(client.cookie("session")).toBe("abc123");

    const { body } = await client.getJson<{ session: string | null }>("/echo-cookie");
    expect(body.session).toContain("session=abc123");
  });

  it("withCookie() seeds the cookie jar", async () => {
    const client = makeClient().withCookie("session", "seeded");
    const { body } = await client.getJson<{ session: string | null }>("/echo-cookie");
    expect(body.session).toContain("session=seeded");
  });

  it("getJson() on a 204 returns undefined instead of throwing (F5)", async () => {
    const client = makeClient();
    const { status, body } = await client.getJson("/no-content");
    expect(status).toBe(204);
    expect(body).toBeUndefined();
  });

  it("getJson() on a non-JSON error body returns undefined instead of throwing (F5)", async () => {
    const client = makeClient();
    const { status, body } = await client.getJson("/not-found-text");
    expect(status).toBe(404);
    expect(body).toBeUndefined();
  });

  it("flush() clears cookies and default headers", async () => {
    const client = makeClient().withToken("tok").withCookie("session", "x");
    client.flush();
    const headers = await client.getJson<{ auth: string | null }>("/echo-headers");
    expect(headers.body.auth).toBeNull();
    const cookie = await client.getJson<{ session: string | null }>("/echo-cookie");
    expect(cookie.body.session).toBeNull();
  });
});
