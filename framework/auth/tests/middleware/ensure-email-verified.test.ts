import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Hasher } from "@mahiframework/encryption";
import { HttpError, HttpResponse, Router, toHonoMiddleware } from "@mahiframework/http";
import { AuthManager } from "../../src/auth-manager.js";
import { AUTH_TOKEN } from "../../src/tokens.js";
import { runWithAuth } from "../../src/auth-context.js";
import type { Guard } from "../../src/guard.js";
import type { Credentials, UserProvider } from "../../src/user-provider.js";
import { authenticate } from "../../src/middleware/authenticate.js";
import { ensureEmailVerified } from "../../src/middleware/ensure-email-verified.js";

interface TestUser {
  id: string;
  email: string;
  email_verified_at: string | null;
}

const verified: TestUser = {
  id: "v",
  email: "v@example.com",
  email_verified_at: "2026-01-01T00:00:00.000Z",
};
const unverified: TestUser = { id: "u", email: "u@example.com", email_verified_at: null };

class StubUserProvider implements UserProvider<TestUser> {
  async retrieveById(): Promise<TestUser | null> {
    return null;
  }
  async retrieveByCredentials(_c: Credentials): Promise<TestUser | null> {
    return null;
  }
  async validateCredentials(): Promise<boolean> {
    return false;
  }
}

/** Resolves the user named by the `x-user` header: "verified" / "unverified" / none. */
const stubGuard: Guard<TestUser> = {
  async user(request) {
    const which = request.header("x-user");

    if (which === "verified") {
      return verified;
    }

    if (which === "unverified") {
      return unverified;
    }

    return null;
  },
};

describe("ensureEmailVerified middleware", () => {
  let hono: Hono;

  beforeEach(() => {
    const app = new Application();
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
      .get("/verified-only", () => HttpResponse.json({ ok: true }))
      .middleware(authenticate(), ensureEmailVerified());
  });

  afterEach(() => clearCurrentApp());

  it("lets a verified user through", async () => {
    const response = await hono.request("/verified-only", { headers: { "x-user": "verified" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("403s an authenticated but unverified user", async () => {
    const response = await hono.request("/verified-only", { headers: { "x-user": "unverified" } });
    expect(response.status).toBe(403);
  });

  it("401s a guest (authenticate runs first)", async () => {
    const response = await hono.request("/verified-only");
    expect(response.status).toBe(401);
  });
});
