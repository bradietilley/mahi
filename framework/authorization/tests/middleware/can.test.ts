import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { HttpError, HttpResponse, Router } from "@mahiframework/http";
import { GateRegistry } from "../../src/gate.js";
import { Policy } from "../../src/policy.js";
import { requireAuth } from "../../src/guards.js";
import { GATE_TOKEN } from "../../src/tokens.js";
import { can } from "../../src/middleware/can.js";

interface User {
  id: string;
}
interface PostRow {
  id: string;
  user_id: string;
  published: boolean;
}

const alice: User = { id: "alice" };
const bob: User = { id: "bob" };

class Post {}

class PostPolicy extends Policy<User, PostRow> {
  view(user: User | null, post: PostRow): boolean {
    if (post.published) {
      return true;
    }

    return user !== null && post.user_id === user.id;
  }

  update = requireAuth<User, [PostRow]>((user, post) => post.user_id === user.id);
  create = requireAuth<User, []>(() => true);

  /** Deliberately nullable — an ability whose subject is optional. */
  viewMaybe(_user: User | null, post: PostRow | null): boolean {
    return post === null;
  }
}

const alicePost: PostRow = { id: "p1", user_id: "alice", published: false };

class MissingAuthScope extends Error {}

describe("can middleware", () => {
  let currentUser: User | null;
  let authThrows: boolean;
  let hono: Hono;

  beforeEach(() => {
    currentUser = alice;
    authThrows = false;

    const app = new Application();
    // Stands in for @mahiframework/auth's AuthManager.
    app.instance("auth", {
      userOrNull: () => {
        if (authThrows) {
          throw new MissingAuthScope();
        }

        return currentUser;
      },
    });

    const gate = new GateRegistry(app);
    gate.policy(Post, PostPolicy);
    app.instance(GATE_TOKEN, gate);
    setCurrentApp(app);

    hono = new Hono();
    hono.onError((error) => {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }

      return Response.json({ error: error.constructor.name }, { status: 500 });
    });

    const router = new Router(hono);
    router
      .patch("/posts/{id}", () => HttpResponse.json({ updated: true }))
      .middleware(can("update", Post, () => alicePost));
    router
      .post("/posts", () => HttpResponse.json({ created: true }))
      .middleware(can("create", Post));
    router
      .get("/posts/{id}", () => HttpResponse.json({ ok: true }))
      .middleware(can("view", Post, () => alicePost));
  });

  afterEach(() => clearCurrentApp());

  it("runs the handler when the policy allows", async () => {
    const response = await hono.request("/posts/p1", { method: "PATCH" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: true });
  });

  it("returns 403 when the policy denies", async () => {
    currentUser = bob;

    const response = await hono.request("/posts/p1", { method: "PATCH" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("does not run the handler when denied", async () => {
    currentUser = bob;
    let ran = false;

    const app = new Hono();
    app.onError((error) =>
      Response.json({}, { status: error instanceof HttpError ? error.status : 500 }),
    );
    const router = new Router(app);
    router
      .patch("/posts/{id}", () => {
        ran = true;

        return HttpResponse.json({});
      })
      .middleware(can("update", Post, () => alicePost));

    await app.request("/posts/p1", { method: "PATCH" });
    expect(ran).toBe(false);
  });

  it("works with a bare model class and no resolver", async () => {
    const response = await hono.request("/posts", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("returns 403 for a guest hitting a requireAuth-backed ability", async () => {
    currentUser = null;

    const response = await hono.request("/posts", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("uses 403, not 401 — authorization, not authentication", async () => {
    // A different token wouldn't help Bob here; the resource simply isn't
    // his. Conflating this with 401 would tell clients to re-authenticate
    // pointlessly.
    currentUser = bob;

    const response = await hono.request("/posts/p1", { method: "PATCH" });
    expect(response.status).not.toBe(401);
  });

  it("lets a guest-aware policy admit an anonymous request", async () => {
    currentUser = null;

    const response = await hono.request("/posts/p1", { method: "GET" });
    // alicePost is unpublished, so a guest is denied by PostPolicy.view.
    expect(response.status).toBe(403);
  });

  describe("a resolver that finds nothing", () => {
    function appWith(resolve: () => unknown, ability = "update"): Hono {
      const instance = new Hono();
      instance.onError((error) =>
        error instanceof HttpError
          ? Response.json({ error: error.message }, { status: error.status })
          : Response.json({ error: error.constructor.name }, { status: 500 }),
      );
      new Router(instance)
        .patch("/posts/{id}", () => HttpResponse.json({ updated: true }))
        .middleware(can(ability, Post, resolve));

      return instance;
    }

    it("404s instead of 500ing", async () => {
      // `undefined` means the row doesn't exist. Passing it into the
      // policy blew up on the first property access, turning "no such
      // post" into "the server is broken" — and leaking, via the status
      // code, that the id was well-formed.
      const response = await appWith(() => undefined).request("/posts/nope", { method: "PATCH" });

      expect(response.status).toBe(404);
    });

    it("still passes an explicit null through to the policy", async () => {
      // `null` is a deliberate "no subject", distinct from "not found" —
      // an ability may legitimately take one, and must still be consulted
      // rather than short-circuited into a 404.
      const response = await appWith(() => null, "viewMaybe").request("/posts/p1", {
        method: "PATCH",
      });

      expect(response.status).toBe(200);
    });
  });

  it("surfaces a missing auth scope rather than silently authorizing", async () => {
    // If authenticate() never ran, the underlying error must propagate —
    // treating the request as a guest here would be a silent
    // authorization decision made by accident.
    authThrows = true;

    const response = await hono.request("/posts/p1", { method: "PATCH" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "MissingAuthScope" });
  });
});
