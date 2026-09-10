import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { Hasher } from "@mahi/encryption";
import { HttpError, HttpResponse, Router, toHonoMiddleware } from "@mahi/http";
import { AuthManager } from "../../src/auth-manager.js";
import { Auth } from "../../src/auth-facade.js";
import { AUTH_TOKEN } from "../../src/tokens.js";
import { MissingAuthContextError, runWithAuth } from "../../src/auth-context.js";
import type { Guard } from "../../src/guard.js";
import type { Credentials, UserProvider } from "../../src/user-provider.js";
import { authenticate, authenticateOptional } from "../../src/middleware/authenticate.js";

interface TestUser {
  id: string;
  email: string;
}

const alice: TestUser = { id: "alice", email: "alice@example.com" };

class StubUserProvider implements UserProvider<TestUser> {
  async retrieveById(): Promise<TestUser | null> {
    return alice;
  }
  async retrieveByCredentials(_c: Credentials): Promise<TestUser | null> {
    return null;
  }
  async validateCredentials(): Promise<boolean> {
    return false;
  }
}

/** Authenticates iff the request carries `Authorization: Bearer valid`. */
const stubGuard: Guard<TestUser> = {
  async user(request) {
    return request.header("Authorization") === "Bearer valid" ? alice : null;
  },
};

describe("authenticate middleware", () => {
  let app: Application;
  let hono: Hono;

  beforeEach(() => {
    app = new Application();
    const manager = new AuthManager(
      app,
      { default: "token", guards: { token: { provider: "users" } }, providers: { users: {} } },
      new Hasher(),
    );
    manager.extendUserProvider("database", () => new StubUserProvider());
    manager.extend("token", () => stubGuard);
    app.instance(AUTH_TOKEN, manager);
    setCurrentApp(app);

    hono = new Hono();
    hono.use(
      "*",
      toHonoMiddleware([
        (request, next) => runWithAuth({ user: null, guard: null }, () => next(request)),
      ]),
    );
    hono.onError((error) => {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }

      return Response.json({ error: String(error) }, { status: 500 });
    });

    const router = new Router(hono);
    router
      .get("/private", () => HttpResponse.json({ user: Auth.user() }))
      .middleware(authenticate());
    router
      .get("/public", () => HttpResponse.json({ user: Auth.userOrNull() }))
      .middleware(authenticateOptional());
    router
      .get("/public-strict", () => HttpResponse.json({ user: Auth.user() }))
      .middleware(authenticateOptional());
  });

  afterEach(() => clearCurrentApp());

  it("passes an authenticated request through and exposes the user", async () => {
    const response = await hono.request("/private", {
      headers: { Authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: alice });
  });

  it("rejects a request with no credentials as 401", async () => {
    const response = await hono.request("/private");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects invalid credentials as 401", async () => {
    const response = await hono.request("/private", {
      headers: { Authorization: "Bearer wrong" },
    });

    expect(response.status).toBe(401);
  });

  it("uses 401, not 403 — the request may succeed with different credentials", async () => {
    const response = await hono.request("/private");
    expect(response.status).not.toBe(403);
  });

  describe("authenticateOptional", () => {
    it("lets guests through with a null user", async () => {
      const response = await hono.request("/public");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ user: null });
    });

    it("still resolves a user when credentials are present", async () => {
      const response = await hono.request("/public", {
        headers: { Authorization: "Bearer valid" },
      });

      await expect(response.json()).resolves.toEqual({ user: alice });
    });

    it("does not soften Auth.user(), which still throws for guests", async () => {
      const response = await hono.request("/public-strict");
      expect(response.status).toBe(500);
    });
  });

  it("surfaces MissingAuthContextError when the global scope pipe never ran", async () => {
    const bare = new Hono();
    let caught: unknown;
    let handlerRan = false;

    bare.onError((error) => {
      caught = error;

      return Response.json({ error: "boom" }, { status: 500 });
    });
    const router = new Router(bare);
    router
      .get("/private", () => {
        handlerRan = true;

        return HttpResponse.json({ ok: true });
      })
      .middleware(authenticate());

    const response = await bare.request("/private", {
      headers: { Authorization: "Bearer valid" },
    });

    expect(caught).toBeInstanceOf(MissingAuthContextError);
    expect(response.status).toBe(500);
    expect(handlerRan).toBe(false);
  });
});
